const { validateId, getAUserById } = require("../utils/utils")
const {  balanceOf } = require('../../web3Services/web3.services');
const { config } = require("dotenv");
config();
const { abiJSON } = require("../../utils/abi");
const Web3 = require('web3');
const web3 = new Web3('https://data-seed-prebsc-1-s1.binance.org:8545');


async function fakeData(parent, args, context) {
  return await context.prisma.fakedata.findMany();
}

async function allPassengers(parent, args, context) {
  const userDetails = await getAUserById(context);
  return await context.prisma.user.findMany({
    where: { role: 'PASSENGER' },
  });
}

async function allPassengersIndex(parent, args, context) {
  const userDetails = await getAUserById(context);
  const result = await context.prisma.user.findMany({
    where: { role: 'PASSENGER' },
  })

  return  Object.keys(result).length;
}

async function allAirlineAdmins(parent, args, context) {

  const userDetails = await getAUserById(context);
  return context.prisma.user.findMany({
    where: { role: 'AIRLINE' },
  }); 
}

async function allAeropayeAdmins(parent, args, context) {
  const userDetails = await getAUserById(context);
  return context.prisma.user.findMany({
    where: { role: 'ADMIN' }, 
  }); 
}


async function getAUser (parent, args, context) {

  const userDetails = await getAUserById(context);

  const details = await context.prisma.user.findUnique({
    where: {
      id: userDetails.id
    }
  })
  return details

} 



// async function getAUser (parent, args, context) {
//   const result = await validateId(args, context);
//   if(!result) return null
//   return context.prisma.user.findUnique({
//     where: { id: context?.userId },
//   });
// }

async function getAFlightById (parent, args, context) {
  const result = await validateId(args, context);
  if(!result) return null
  return context.prisma.flight.findUnique({
    where: { id: context?.userId },
  });
}

async function verifyEmailToken(parent, args, context, info) {
  const password = await bcrypt.hash(args.password, 10);
  const user = await context.prisma.user.create({
    data: { ...args, password },
  });
  const token = jwt.sign({ userId: user.id }, APP_SECRET);
  return {
    token,
    user,
  };
}

async function getAvailableFlights(parent, args, context, info) {
  // let options = args.airlineName ? { status: args.status, airlineName: args.airlineName } : { status: args.status }
  const userDetails = await getAUserById(context);
  const flight = await context.prisma.flight.findMany();
  return flight
}

async function getAvailableFlightsIndex(parent, args, context, info) {
  // let options = args.airlineName ? { status: args.status, airlineName: args.airlineName } : { status: args.status }
  const userDetails = await getAUserById(context);
  const flight = await context.prisma.flight.findMany(); 

  return Object.keys(flight).length 
} 

async function getAllFlights(parent, args, context, info) {

  const userDetails = await getAUserById(context);
  const flight = await context.prisma.flight.findMany()

  return flight
} 

async function getAirlines(parent, args, context, info) {
  // let options = args.airlineName ? { status: args.status, airlineName: args.airlineName } : { status: args.status }
  const userDetails = await getAUserById(context);
  const airlines = await context.prisma.airline.findMany();
  return airlines
}

async function getAirlineIndex(parent, args, context, info) {
  // let options = args.airlineName ? { status: args.status, airlineName: args.airlineName } : { status: args.status }
  const userDetails = await getAUserById(context);
  const airlines = await context.prisma.airline.findMany();

  console.log(airlines)

  return Object.keys(airlines).length 
} 

// async function escrowBalance(parent, args, context, info) {
 
//   // const userDetails = await getAUserById(context);
 
//   const aeropayeAddress = process.env.CONTRACT; 
//   // const holderAddress = "0x43DD177A4caE42683B3C693456B9C2f0CF2901E3";

//   // just the `balanceOf()` is sufficient in this case

//   const contract = new web3.eth.Contract(abiJSON, aeropayeAddress);
//   // console.log(contract);
 

//   const flightEscrows = await context.prisma.booked.findMany();

//   let escrows = flightEscrows.map(a => a.flightEscrow);
//   // console.log(escrows);

//   let balance;
//   let sum = 0; 
//   let array = [];



//   for (let i = 0; i < escrows.length; i++) {

//     balance = await contract.methods.balanceOf(escrows[i]).call();
//     array.push(balance);
//   }

//   // console.log(array);

//   for (let i = 0; i < array.length; i++) {

//     let newArray = Math.floor(array[i])


//     sum += newArray;

//   }



//   return sum;

// }

async function balance(parent, args, context, info) {
  const userDetails = await getAUserById(context);

  const escrowTransfer = await balanceOf(userDetails.addr);

  return {
    status: "success",
    data: escrowTransfer
  }
}

async function userBankDetails(parent, args, context, info) {
  const userDetails = await getAUserById(context);

  return context.prisma.usersbanklist.findMany({
    where: { userId: userDetails.id }, 
  });  
} 

async function userVerificationStatus(parent, args, context, info) {
  const userDetails = await getAUserById(context);

  const details = await context.prisma.user.findUnique({
    where: {
      id: userDetails.id
    }
  })
  return details.emailVerified
  
}

async function getBookedFlight(parent, args, context, info) {
  // let options = args.airlineName ? { status: args.status, airlineName: args.airlineName } : { status: args.status }
 
  const userDetails = await getAUserById(context);
  const flight = await context.prisma.booked.findMany(
    {
      where: {
        userId: userDetails.id, 
      }
    } 
  );
  return flight
}

async function bookedFlightHistory(parent, args, context, info) {
  // let options = args.airlineName ? { status: args.status, airlineName: args.airlineName } : { status: args.status }
 
  const userDetails = await getAUserById(context);
  const flight = await context.prisma.booked.findMany(
    {
      where: {
        userId: userDetails.id, 
      }
    } 
  );
  return flight
}

async function transactions(parent, args, context, info) {
  const userDetails = await getAUserById(context);

  return context.prisma.wallettransactions.findMany({
    where: { userId: userDetails.id }, 
  });  
}

async function airlinesRefund(parent, args, context, info) {
  const userDetails = await getAUserById(context);

  return context.prisma.airlinerefunds.findMany(
    {
    where: { airlineName: args.airlineName }, 
  }
  );  
} 

// async function transactionsAdmin(parent, args, context, info) {
//   // const userDetails = await getAUserById(context);

//   return context.prisma.wallettransactions.findMany(
//   //   {
//   //   where: { userId: userDetails.id }, 
//   // }
//   );  
// }

module.exports = {
  // allPassengers,
  // allPassengersIndex,
  // allAirlineAdmins, 
  // allAeropayeAdmins,
  getAUser,
  getAFlightById,
  // verifyEmailToken,
  getAvailableFlights,
  getAvailableFlightsIndex,
  getAllFlights,
  // getAirlines,
  // getAirlineIndex, 
  // escrowBalance,
  balance,
  userBankDetails,
  getBookedFlight,
  transactions,
  // transactionsAdmin,
  userVerificationStatus, 
  fakeData,
  bookedFlightHistory,
  airlinesRefund
}; 
