const { PubSub, withFilter } = require('graphql-subscriptions');
const { PrismaClient } = require("@prisma/client")
const { checkIn } = require('./Mutation');

const pubsub = new PubSub();
const prisma = new PrismaClient()





    const Subscription = {
        checkinCreated: {
            subscribe:  (parent, args, { pubsub }, info) => 
            { 
                return  pubsub.asyncIterator('CHECKIN_CREATED')
        

            }
        } 
    }


 

// const Subscription = {
//     checkinCreated: {
//         subscribe: withFilter ( 
//             (parent, args, { pubsub }, info) => pubsub.asyncIterator('CHECKIN_CREATED'),
//             (payload, variables) => {
//                 // Only push an update if the comment is on
//                 // the correct repository for this operation
//                 return (payload.checkinCreated.flightCode === variables.flightCode);
//               },
//             )
        

//     }
// }

module.exports = Subscription;