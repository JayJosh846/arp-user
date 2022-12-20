
const { PrismaClient } = require('@prisma/client')
// const { ApolloServer } = require("apollo-server");
const { ApolloServer } = require("apollo-server-express");
const { ApolloServerPluginDrainHttpServer } = require("apollo-server-core")
const http = require("http");
const { makeExecutableSchema } = require("@graphql-tools/schema");
const { WebSocketServer } = require("ws");
const {SubscriptionServer} = require("subscriptions-transport-ws");
const {execute, subscribe} = require("graphql");
const fs = require('fs');
const path = require('path');
const { getUserId } = require('./utils/auth');
const Query = require('./resolvers/Query')
const Mutation = require('./resolvers/Mutation')
const Subscription = require('./resolvers/Subscription');
const { consumeFromQueue } = require("../message.queue/queue")
const { flightWorker } = require('../message.queue/flightWorker');
const { bookedFlightComplete } = require('../message.queue/bookedFlightComplete');
const { deleteClaimedFlight } = require('../message.queue/deleteClaimedFlight'); 
const { airlineCreation } = require('../message.queue/airlineCreation');
const { setRefunds } = require('../message.queue/setRefunds');
const { config } = require("dotenv");
config();
const express = require('express')
const cors = require('cors');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const {merge} = require('lodash')
const { PubSub } = require('graphql-subscriptions');
const { ApolloArmor } = require('@escape.tech/graphql-armor');
const { Kind, GraphQLScalarType } = require('graphql');

const pubsub = new PubSub();


const app = express()
const httpServer = http.createServer(app);

const PORT = process.env.PORT;

const CORS_CONFIG = {
  origin: true,
  exposedHeaders: ["Content-Range", "X-Content-Range"],
};

app.options("*", cors());
app.use(cors(CORS_CONFIG));
app.set("trust proxy", 1);


// app.use(cors({
//   origin: "*"

// })) 

// app.use(cors({
//   origin: ['http://localhost:3000', 'localhost:3000', 'https://vercel.com/convexity/aeropaye-landing-page', 
//   'https://vercel.com/convexity/aeropaye-dashboard', 'https://aeropaye-user.herokuapp.com/', 
//   'https://dashboard.aeropaye.com/', 'https://dashboard.aeropaye.com', 'https://aeropaye-user.herokuapp.com',
//   'http://localhost:4003/', 'http://localhost:4003', 'https://dashboard.aeropaye.com/login']

// }))
 // enable `cors` to set HTTP response header: Access-Control-Allow-Origin: *app.use('/graphql', bodyParser.json(), graphqlExpress({ schema }))
// app.listen(PORT)




const prisma = new PrismaClient()


const resolverMap = {
  Date: new GraphQLScalarType({
    name: 'Date',
    description: 'Date custom scalar type',
    parseValue(value) {
      return new Date(value) // value from the client
    },
    serialize(value) {
      return value.getTime() // value sent to the client
    },
    parseLiteral(ast) {
      if (ast.kind === Kind.INT) {
        return new Date(+ast.value) // ast value is always in string format
      }
      return null
    }
  })
}

// const mutationMerge = merge(Mutation, Paymentapi)
 
const resolvers = {
    Query, 
    Mutation, 
    Subscription
  }
  



const armor = new ApolloArmor({
  blockFieldSuggestion: {
    enabled: true
  },
  maxDepth: {
    enabled: true,
    n: 100
  },
  costLimit: {
    enabled: true,
    maxCost: 100, // maximum cost of a request before it is rejected
    objectCost: 2, // cost of retrieving an object
    scalarCost: 1, // cost of retrieving a scalar
    depthCostFactor: 1.5, // multiplicative cost of depth
    ignoreIntrospection: true, // by default, introspection queries are ignored.
  },
  characterLimit: {
    enabled: true,
    maxLength: 2000,
  }
});
const protection = armor.protect();

const schema = makeExecutableSchema({ 
  typeDefs: fs.readFileSync(
    path.join(__dirname, 'schema.graphql'),
    'utf8'
  ), 
  resolvers 
});



  let server;
  async function startApolloServer() {

    server = new ApolloServer({
    schema,
    resolverMap,
    ...protection,
    plugins: [
      ...protection.plugins,
      ApolloServerPluginDrainHttpServer({ httpServer }),
      {
        async serverWillStart() {
          return {
            async drainServer() {
              subscriptionServer.close();
            },
          };
        },
      },
    ],
    allowBatchedHttpRequests: false,
    // validationRules: [...protection.validationRules ],
    context: async({ req }) => {
        return { 
           ...req,
          prisma,
          pubsub,
          userId:
            req && req.headers.authorization
              ? await getUserId(req)
              : null
        };
      }
})

const subscriptionServer = SubscriptionServer.create({ 
  schema, 
  execute, 
  subscribe,
  async onConnect(connectionParams, webSocket, context) {
    console.log('connected');

    return { pubsub };
  },
   onDisconnect(webSocket, context) {
    console.log('disconnected');
  }
},
{ 
  server:httpServer, 
  path: "/graphql"
})

  await server.start();
  server.applyMiddleware({ app });
}

startApolloServer()


// Hand in the schema we just created and have the
  // WebSocketServer start listening.

  httpServer.listen(PORT, function () {
    console.log(`Server is running on ${PORT}`)
    console.log(`gql path is ${server.graphqlPath}`);
});



