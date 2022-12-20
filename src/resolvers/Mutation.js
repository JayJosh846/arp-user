const { config } = require("dotenv");
config();
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { uuid } = require('uuidv4');
const { JWT_SECRET, JWT_EXP, getUserId } = require("../utils/auth");
const { sendOTP, verifyOTP } = require("../../termii.token/termii.token");
const { makeFiatDeposit, verifyDepositedFunds, verifyAccountNumber, transferRecipientCreation, initiateTransfer, } = require("../../payment");
const cache = require("../../cache.redis/cache");
const { getAUserById, getAFlightById, isEmailOrMobileExist } = require("../utils/utils");
const { createPassenger, mintToken, transferEscrow, balanceOf, transfer, cancelBooking,
  passengerCheckIn, airlineClaimBookingFee, airlineEscrow, escrowCreationPayment, transferEscrowPayment, addUserList } = require('../../web3Services/web3.services');
const { publishToQueue, consumeFromQueue } = require("../../message.queue/queue")
const { PrismaClient } = require("@prisma/client")
const { UserInputError, ValidationError, AuthenticationError, ForbiddenError } = require("apollo-server");
const { getAzmanAirFlights, getAirPeaceFlights, getArikAirFlights } = require("../../Services/Airlines/airlineFlights");
const { getDanaAir, getAirPeace, getArikAir } = require("../../Services/Airlines/airlines");
const { sendConfirmationEmail, sendPasswordResetEmail, sendItinerary } = require('../../emailsAPI/emailServices');
const { setUserKeypair } = require('../../utils/keyPair')
const { setAirlineKeypair } = require('../../utils/airlineUtils/keyPair')
const Str = require('@supercharge/strings')
const { generateCryptoDepositQRCode } = require("../../config/qrCode")
const moment = require("moment");

// const { PubSub } = require('graphql-subscriptions');

// let pubsub = new PubSub();


const prisma = new PrismaClient()


const ADMIN_ADDRESS = process.env.ADMIN_ADDRESS;


async function signup(parent, args, context, info) {

  const isUniqueUser = await isEmailOrMobileExist(args, context);

  // const unique = await context.prisma.user.findUnique({
  //   where: {
  //     email: args.email,
  //   }
  // })

  const unique = await context.prisma.user.findMany()

  let result = unique.map(a => a.email);
  const found = result.find(element => element === args.email);

  if (args.email === found) {
    throw new UserInputError('Email or mobile already exists');
  }

  let resultMobile = unique.map(a => a.mobile);
  const foundMobile = resultMobile.find(element => element === args.mobile);

  if (args.mobile === foundMobile) {
    throw new UserInputError('Email or mobile already exists');
  }


  // if (isUniqueUser) {
  //   throw new UserInputError('Email or mobile already exists');
  // } 


  const termiResponse = await sendOTP(args.mobile);
  const { pinId, smsStatus, to } = termiResponse;
  const cached = await cache.setCacheWithExpiration(
    args.mobile,
    1440,
    JSON.stringify(termiResponse)
  );
  if (cached === "OK") {
    const password = await bcrypt.hash(args.password, 10);
    const user = await context.prisma.user.create({
      data: { ...args, password },
    });
    // const token = jwt.sign({ userId: user.id }, JWT_SECRET);
    return {
      // token,
      user,
      smsTokenStatus: smsStatus,
    };
  }

  // const password = await bcrypt.hash(args.password, 10);
  // const user = await context.prisma.user.create({
  //   data: { ...args, password },
  // });
  // const token = jwt.sign({ userId: user.id }, JWT_SECRET);
  // return {
  //   token,
  //   user,
  //   smsTokenStatus: smsStatus,
  // };

}

async function login(parent, args, context, info) {
  const user = await context.prisma.user.findUnique({
    where: { email: args.email },
  });
  if (!user) {
    throw new AuthenticationError("No such user found");
  }
  // if (user.role !== "ADMIN") {
  //   throw new Error("User is not an Admin");

  // }

  if (user.mobileVerified === false) {
    throw new AuthenticationError("Your Phone Number is not verified");
  }
  const valid = await bcrypt.compare(args.password, user.password);
  if (!valid) {
    throw new AuthenticationError("Invalid password");
  }

  const token = jwt.sign({ userId: user.id }, JWT_SECRET,
    { expiresIn: JWT_EXP }
  );
  return {
    token,
    user,
  };
}

async function sendEmailVerification(parent, args, context, info) {

  const user = await getAUserById(context);

  const result = await sendConfirmationEmail(user);

  // if (result === undefined)

  console.log("res", result);

  return {
    status: "success",
    message: "Email Verification Sent"
  }
}


async function verifyUser(parent, args, context, info) {
  //   try {
  const user = await getAUserById(context);

  const foundUser = await context.prisma.userverification.findUnique({
    where: {
      userId: user.id
    }
  })

  if (foundUser) {
    //user verification record exists so we proceed
    const { expiresAt, createdAt } = foundUser;
    const hashedUniqueString = foundUser.uniqueString;

    // checking for expired unique string
    if (expiresAt < createdAt) {
      //record has expired, hence it is deleted
      await context.prisma.userverification.delete({
        where: {
          userId: user.id
        }
      })
      console.log("Verification expired and deleted")

      return false

    } else {
      //valid record exists so we validate the user string
      //First compare that hashed unique string

      await bcrypt.compare(foundUser.uniqueString, hashedUniqueString)

      if (foundUser.uniqueString === hashedUniqueString) {
        //strings match

        // Create user blockchain account with mnemonic from keypair and email as salt
        const pair = await setUserKeypair(user.email);

        const addToList = await addUserList(pair.address);
        console.log("add to list", addToList);


        await context.prisma.user.update({
          where: {
            id: user.id
          },
          data: {
            emailVerified: true,
            addr: pair.address
          }
        })

        await context.prisma.userverification.delete({
          where: {
            userId: user.id
          }
        })
        return true


      } else {
        // existing record but incorrect verification details passed.
        console.log("Invalid verification details passed. Please check your inbox.")
        return false
      }

    }
  }
  else {
    //user verification record doesn't exist
    let message =
      "Account record does not exist or has been verified already. Please sign up or log in.";
    console.log(message);

    return false

  }

};


async function resetPasswordRequest(parent, args, context, info) {

  // const user = await getAUserById(context);

  const user = await context.prisma.user.findUnique({
    where: {
      email: args.email,
    }
  })

  if (!user) {
    throw new UserInputError('Email does not exist. Kindly use a registered email.', {
      argumentName: 'email'
    });
  }

  await sendPasswordResetEmail(user);

  return {
    status: "success",
    message: "Reset Password Email Sent"
  }
}


async function resetPassword(parent, args, context, info) {
  //   try {
  // const user = await getAUserById(context);

  const foundUser = await context.prisma.passwordreset.findUnique({
    where: {
      userId: args.userId
    }
  })

  if (foundUser) {
    //user verification record exists so we proceed
    const { expiresAt, createdAt } = foundUser;
    const hashedUniqueString = foundUser.resetString;

    // checking for expired unique string
    if (expiresAt < createdAt) {
      //record has expired, hence it is deleted
      await context.prisma.passwordreset.delete({
        where: {
          userId: args.userId
        }
      })

      return {
        status: "failed",
        message: "Password reset link has expired"
      }

    } else {
      //valid record exists so we validate the user string
      //First compare that hashed unique string

      await bcrypt.compare(foundUser.resetString, hashedUniqueString)

      if (foundUser.resetString === hashedUniqueString) {
        //strings match

        const saltRounds = 10;
        const newHashedPass = await bcrypt.hash(args.newPassword, saltRounds)

        await context.prisma.user.update({
          where: {
            id: args.userId
          },
          data: {
            password: newHashedPass
          }
        })

        await context.prisma.passwordreset.delete({
          where: {
            userId: args.userId
          }
        })
        return {
          status: "success",
          message: "Password has been reset successfully"
        }

      } else {
        // existing record but incorrect verification details passed.
        console.log("Invalid password reset details passed")
        return {
          status: "failed",
          message: "Invalid password reset details passed"
        }
      }

    }
  }
  else {
    //user verification record doesn't exist
    let message =
      "Password reset request not found";
    console.log(message);

    return {
      status: "failed",
      message: message
    }
  }

};


async function sendEmailOTP(parent, args, context, info) {
  const password = await bcrypt.hash(args.password, 10);
  const user = await context.prisma.user.create({
    data: { ...args, password },
  });
  const token = jwt.sign({ userId: user.id }, JWT_SECRET);
  return {
    token,
    user,
  };
}

async function verifyMobileWithTermiiToken(parent, args, context, info) {

  const result = await cache.getCachedItem(args.msisdn);
  if (!result) {

    throw new AuthenticationError("Invalid number");
  }

  const { pinId } = JSON.parse(result);
  const termiResponse = await verifyOTP(pinId, args.pin);

  if (
    termiResponse.verified === false ||
    termiResponse.verified === "Expired" ||
    termiResponse.status == 400
  ) {


    throw new UserInputError('Invalid code entered', {
      argumentName: 'pin'
    });


  } else if (termiResponse.status == 200 || termiResponse.verified) {
    // console.log('token', termiResponse);
    // const passengerAccount = await createPassenger();
    // const { address: addr, privateKey: pvtKey } = passengerAccount.data;
    const user = await context.prisma.user.update({
      where: {
        mobile: args.msisdn,
      },
      data: {
        // addr,
        // pvtKey,
        mobileVerified: true
      },
    });
    if (user) {
      return {
        msisdn: termiResponse.msisdn,
        verified: termiResponse.verified,
      }
    }
  }

}


async function sendTermiiTokenToMobile(parent, args, context, info) {
  const termiResponse = await sendOTP(args.msisdn);
  const cached = await cache.setCacheWithExpiration(
    args.msisdn,
    1440,
    JSON.stringify(termiResponse)
  );
  return {
    msisdn: termiResponse.to,
    pinId: termiResponse.pinId,
    status: termiResponse.smsStatus,
  };
}

async function makePayment(parent, args, context, info) {

  //user makes payment
  const userDetails = await getAUserById(context);


  const { amountDeposited } = args;

  if (!amountDeposited) {

    throw new UserInputError('Amount is required to carry out the deposit', {
      argumentName: 'amountDeposited'
    });

  }

  const paymentRes = await makeFiatDeposit(amountDeposited, userDetails.email);

  console.log(paymentRes);


  if (paymentRes.status !== true) {

    throw new ForbiddenError("Failed!. An error occurred trying to complete deposit");
  }

  else if (paymentRes.status === true) {

    // store data in Transaction DB
    const newTransaction = {
      from: userDetails.email,
      userFirstName: userDetails.firstname,
      userLastName: userDetails.lastname,
      amount: amountDeposited,
      email: userDetails.email,
      reference: paymentRes.data.reference,
      description: "Funding wallet via paystack",
      trxType: "Deposit"
    }

    await context.prisma.transactions.create({
      data: { ...newTransaction },
    });



    return { data: paymentRes.data }

  }
}


async function mint(parent, args, context, info) {

  const userDetails = await getAUserById(context);


  const transaction = await context.prisma.transactions.findMany({
    where: {
      email: userDetails.email,
      status: "pending"
    }
  });

  // console.log(transaction);

  //call the last pending transaction from the db
  let transactionIndex = transaction[transaction.length - 1];



  console.log(transactionIndex);

  // Verify User Transaction

  // const {
  //   status,
  //   amount,
  //   data: {
  //     reference,
  //     channel,
  //     currency,
  //     paid_at,
  //     created_at,
  //     custormer: { email }
  //   }
  // } 

  const verifiedTrans = await verifyDepositedFunds(transactionIndex.reference);

  // console.log("verification", verifiedTrans);


  if (verifiedTrans.status !== true) {
    throw new ValidationError("Verification failed");
  }

  // if status is successful update users transaction table


  //  Check trx_ref to make sure that double deposit is not done (DO THIS LATER)
  // const existingTrx = await context.prisma.Transactions.findUnique({
  //   where: {
  //     reference: reference
  //   }
  // });

  //Update Transaction DB
  await context.prisma.transactions.update({
    where: {
      reference: verifiedTrans.data.reference
    },
    data: {
      amount: verifiedTrans.data.amount,
      reference: verifiedTrans.data.reference,
      channel: verifiedTrans.data.channel,
      currency: verifiedTrans.data.currency,
      paid_at: verifiedTrans.data.paid_at,
      created_at: verifiedTrans.data.created_at
    }
  });

  if (transactionIndex.status === "complete") {

    throw new ForbiddenError("Failed! Transaction has already been fulfilled");
  }

  //Mint tokens to user

  const newAmount = verifiedTrans.data.amount / 100;

  const mintResult = await mintToken(newAmount, userDetails.addr)
  console.log("minted Token", mintResult);

  if (mintResult) {
    await context.prisma.transactions.update({
      where: {
        reference: verifiedTrans.data.reference
      },
      data: {
        status: "complete"
      }
    });

    const balanceWallet = await balanceOf(userDetails.addr)


    // update user table
    const user = await context.prisma.user.findUnique({
      where: {
        id: userDetails.id
      }
    })
    const usTotalDeposit = user.totalDeposits || 0;
    await context.prisma.user.update({
      where: {
        id: userDetails.id
      },
      data: {
        walletBalance: balanceWallet.data,
        totalDeposits: newAmount + usTotalDeposit
      }
    })

    // update transaction table
    await context.prisma.wallettransactions.create({
      data: {
        userId: userDetails.id,
        from: userDetails.email,
        fromAddr: userDetails.addr,
        amount: newAmount,
        description: "Funding wallet via paystack",
        trxType: "Deposit",
        status: "Completed"
      }
    });

    // const newAmount = verifiedTrans.data.amount / 100;

    return {
      status: "success",
      message: `Succssfully minted ${newAmount} ARP into your wallet`,
      data: null,
    }
  } else {
    throw new ForbiddenError("Failed! Something went wrong trying to mint tokens to your wallet");
  }

}



async function bookFlight(parent, args, context, info) {

  // const flight = await context.prisma.flight.findMany();

  const userDetails = await getAUserById(context);
  const azmanAirDetails = await getAzmanAirFlights(args, context);
  const airPeaceDetails = await getAirPeaceFlights(args, context);
  const arikAirDetails = await getArikAirFlights(args, context);
  const pair = await setUserKeypair(userDetails.email);


  let flightCodeGenerator = Math.floor(Math.random() * 1000000);
  let ticker = "";

  ticker = "TK" + flightCodeGenerator;

  if (azmanAirDetails !== undefined &&

    azmanAirDetails.flightCode === args.flightCode) {

    // check if flight has already been booked

    const checkBooked = await context.prisma.booked.findMany({
      where: {
        userId: userDetails.id,
        flightCode: args.flightCode
      }
    });

    if (checkBooked.length == 0) {

      // check if user has enough balance
      const numOfChildren = args.numOfChildren || 0
      const numOfInfants = args.numOfInfants || 0

      const totalNumOfPassengers = args.numOfAdults + numOfChildren + numOfInfants;

      const totalAmount = totalNumOfPassengers * parseInt(args.amount)

      const userBalance = await balanceOf(userDetails.addr);

      if (parseInt(userBalance.data) < totalAmount) {
        throw new UserInputError('Insufficient funds. Fund your wallet. ');
      }

      // const escrowTransfer = await transferEscrow(
      //   azmanAirDetails.flightEscrow,
      //   azmanAirDetails.airlineAddres,
      //   pair.address,
      //   totalAmount.toString(),
      //   args.class,
      //   azmanAirDetails.apstatus,
      //   ticker,
      //   pair.privateKey
      // )

      // console.log("Transfer to escrow", escrowTransfer);


      const transferResult = await transfer(
        pair.address,
        pair.privateKey,
        azmanAirDetails.airlineAddres,
        totalAmount.toString()
      );

      console.log("Transfer to airline", transferResult);

      const bookedflightDetails = {
        userId: userDetails.id,
        userFirstName: userDetails.firstname,
        userLastName: userDetails.lastname,
        email: userDetails.email,
        airlineName: azmanAirDetails.airlineName,
        airlineAddres: azmanAirDetails.airlineAddres,
        departureInfo: azmanAirDetails.departureInfo,
        arrivalInfo: azmanAirDetails.arrivalInfo,
        airlineId: azmanAirDetails.airlineId,
        ticketId: ticker,
        flightEscrow: azmanAirDetails.flightEscrow,
        amount: totalAmount.toString(),
        ...args,
      }

      const booked = await context.prisma.booked.create({
        data: { ...bookedflightDetails },
      });

      // update user table
      const flight = await context.prisma.booked.findMany({
        where: {
          userId: userDetails.id
        }
      });
      const user = await context.prisma.user.findUnique({
        where: {
          id: userDetails.id
        }
      })
      const usTotalFee = user.totalFee || 0;
      const balanceWallet = await balanceOf(userDetails.addr)
      await context.prisma.user.update({
        where: {
          id: userDetails.id
        },
        data: {
          walletBalance: balanceWallet.data,
          numOfFlights: Object.keys(flight).length,
          totalFee: totalAmount + usTotalFee,
        }
      })
      //update booked db
      const bookUpdate = await context.prisma.booked.update({
        where: {
          ticketId: ticker
        },
        data: {
          apstatus: '2',
          status: 'ONGOING',
          amount: totalAmount.toString(),
        },
      });

      //update flight db
      // add the total number of passengers (eg adults, children and infants who booked flight)

      const passengerCount = bookUpdate.numOfAdults + bookUpdate.numOfChildren + bookUpdate.numOfInfants

      const flightQuery = await context.prisma.flight.findUnique({
        where: {
          flightCode: args.flightCode
        }
      })

      const fqPass = flightQuery.pass || 0;
      const fqTotalFee = flightQuery.totalFee || 0;

      const flightUpdate = await context.prisma.flight.update({
        where: {
          flightCode: args.flightCode
        },
        data: {
          pass: passengerCount + fqPass,
          totalFee: totalAmount + fqTotalFee,
          status: 'ONGOING'
        }
      })

      console.log("flightUpdate", flightUpdate);
      // create wallet transaction

      await context.prisma.wallettransactions.create({
        data: {
          userId: userDetails.id,
          from: userDetails.email,
          fromAddr: userDetails.addr,
          receiverName: azmanAirDetails.airlineName,
          receiverAddr: azmanAirDetails.airlineAddres,
          amount: totalAmount,
          description: `Booking paid to: ${azmanAirDetails.airlineName}`,
          trxType: "Booking",
          status: "Completed"
        }
      });





      // percentage goes to airline wallet

      // const airlineDetails = await context.prisma.flight.findMany();
      // let result = airlineDetails.map(a => a.flightEscrow);  
      // const airline = await context.prisma.airline.findUnique({
      //   where: {
      //     id: azmanAirDetails.airlineId
      //   }
      // })

      // const pairAirline = await setAirlineKeypair(airline.email);
      // const { data: { flightEscrow } } = await airlineEscrow(azmanAirDetails.airlineAddres);
      // let flightesrwIndex = flightEscrow.indexOf(azmanAirDetails.flightEscrow);
      // const bookingClaimResult =
      // await airlineClaimBookingFee(azmanAirDetails.flightEscrow, flightesrwIndex, pairAirline.address, pairAirline.privateKey);

      await publishToQueue("bookedFlight", JSON.stringify(bookUpdate));
      await publishToQueue("updateFlight", JSON.stringify(flightUpdate));

      return {
        bookUpdate
      };

    }

    else {
      let checkBookedIndex = checkBooked[checkBooked.length - 1];


      if (checkBookedIndex.status === "ONGOING") {
        throw new ForbiddenError("Flight booked. Go to Paid Flights to view already paid flights.");
      }

      // check if user has enough balance
      const numOfChildren = args.numOfChildren || 0
      const numOfInfants = args.numOfInfants || 0

      const totalNumOfPassengers = args.numOfAdults + numOfChildren + numOfInfants;

      const totalAmount = totalNumOfPassengers * parseInt(args.amount)

      const userBalance = await balanceOf(userDetails.addr);

      if (parseInt(userBalance.data) < totalAmount) {
        throw new UserInputError('Insufficient funds. Fund your wallet. ');
      }

      // const escrowTransfer = await transferEscrow(
      //   azmanAirDetails.flightEscrow,
      //   azmanAirDetails.airlineAddres,
      //   pair.address,
      //   totalAmount.toString(),
      //   args.class,
      //   azmanAirDetails.apstatus,
      //   ticker,
      //   pair.privateKey
      // )

      // console.log("Transfer to escrow", escrowTransfer);


      const transferResult = await transfer(
        pair.address,
        pair.privateKey,
        azmanAirDetails.airlineAddres,
        totalAmount.toString()
      );

      console.log("Transfer to airline", transferResult);

      const bookedflightDetails = {
        userId: userDetails.id,
        userFirstName: userDetails.firstname,
        userLastName: userDetails.lastname,
        email: userDetails.email,
        airlineName: azmanAirDetails.airlineName,
        airlineAddres: azmanAirDetails.airlineAddres,
        departureInfo: azmanAirDetails.departureInfo,
        arrivalInfo: azmanAirDetails.arrivalInfo,
        airlineId: azmanAirDetails.airlineId,
        ticketId: ticker,
        flightEscrow: azmanAirDetails.flightEscrow,
        amount: totalAmount.toString(),
        ...args,
      }

      const booked = await context.prisma.booked.create({
        data: { ...bookedflightDetails },
      });

      // update user table
      const flight = await context.prisma.booked.findMany({
        where: {
          userId: userDetails.id
        }
      });
      const user = await context.prisma.user.findUnique({
        where: {
          id: userDetails.id
        }
      })
      const usTotalFee = user.totalFee || 0;
      const balanceWallet = await balanceOf(userDetails.addr)
      await context.prisma.user.update({
        where: {
          id: userDetails.id
        },
        data: {
          walletBalance: balanceWallet.data,
          numOfFlights: Object.keys(flight).length,
          totalFee: totalAmount + usTotalFee,
        }
      })

      //update booked db
      const bookUpdate = await context.prisma.booked.update({
        where: {
          ticketId: ticker
        },
        data: {
          apstatus: '2',
          status: 'ONGOING',
          amount: totalAmount.toString(),
        },
      });

      //update flight db
      // add the total number of passengers (eg adults, children and infants who booked flight)

      const passengerCount = bookUpdate.numOfAdults + bookUpdate.numOfChildren + bookUpdate.numOfInfants

      const flightQuery = await context.prisma.flight.findUnique({
        where: {
          flightCode: args.flightCode
        }
      })

      const fqPass = flightQuery.pass || 0;
      const fqTotalFee = flightQuery.totalFee || 0;

      const flightUpdate = await context.prisma.flight.update({
        where: {
          flightCode: args.flightCode
        },
        data: {
          pass: passengerCount + fqPass,
          totalFee: totalAmount + fqTotalFee,
          status: 'ONGOING'
        }
      })

      console.log("flightUpdate", flightUpdate);
      // create wallet transaction

      await context.prisma.wallettransactions.create({
        data: {
          userId: userDetails.id,
          from: userDetails.email,
          fromAddr: userDetails.addr,
          receiverName: azmanAirDetails.airlineName,
          receiverAddr: azmanAirDetails.airlineAddres,
          amount: totalAmount,
          description: `Booking paid to: ${azmanAirDetails.airlineName}`,
          trxType: "Booking",
          status: "Completed"
        }
      });





      // percentage goes to airline wallet

      // const airlineDetails = await context.prisma.flight.findMany();
      // let result = airlineDetails.map(a => a.flightEscrow);  
      // const airline = await context.prisma.airline.findUnique({
      //   where: {
      //     id: azmanAirDetails.airlineId
      //   }
      // })

      // const pairAirline = await setAirlineKeypair(airline.email);
      // const { data: { flightEscrow } } = await airlineEscrow(azmanAirDetails.airlineAddres);
      // let flightesrwIndex = flightEscrow.indexOf(azmanAirDetails.flightEscrow);
      // const bookingClaimResult =
      // await airlineClaimBookingFee(azmanAirDetails.flightEscrow, flightesrwIndex, pairAirline.address, pairAirline.privateKey);

      await publishToQueue("bookedFlight", JSON.stringify(bookUpdate));
      await publishToQueue("updateFlight", JSON.stringify(flightUpdate));

      return {
        bookUpdate
      };
    }


  }
  else if (airPeaceDetails !== undefined &&
    airPeaceDetails.flightCode === args.flightCode) {

    // check if flight has already been booked

    const checkBooked = await context.prisma.booked.findMany({
      where: {
        userId: userDetails.id,
        flightCode: args.flightCode
      }
    })

    if (checkBooked == 0) {

      // check if user has enough balance
      const numOfChildren = args.numOfChildren || 0
      const numOfInfants = args.numOfInfants || 0

      const totalNumOfPassengers = args.numOfAdults + numOfChildren + numOfInfants;

      const totalAmount = totalNumOfPassengers * parseInt(args.amount)

      const userBalance = await balanceOf(userDetails.addr);

      if (parseInt(userBalance.data) < totalAmount) {
        throw new UserInputError('Insufficient funds. Fund your wallet. ');
      }

      // const escrowTransfer = await transferEscrow(
      //   airPeaceDetails.flightEscrow,
      //   airPeaceDetails.airlineAddres,
      //   pair.address,
      //   totalAmount.toString(),
      //   args.class,
      //   airPeaceDetails.apstatus,
      //   ticker,
      //   pair.privateKey
      // )

      // console.log("Transfer to escrow", escrowTransfer);

      const transferResult = await transfer(
        pair.address,
        pair.privateKey,
        airPeaceDetails.airlineAddres,
        totalAmount.toString()
      );

      console.log("Transfer to airline", transferResult);

      const bookedflightDetails = {
        userId: userDetails.id,
        userFirstName: userDetails.firstname,
        userLastName: userDetails.lastname,
        email: userDetails.email,
        airlineName: airPeaceDetails.airlineName,
        airlineAddres: airPeaceDetails.airlineAddres,
        departureInfo: airPeaceDetails.departureInfo,
        arrivalInfo: airPeaceDetails.arrivalInfo,
        airlineId: airPeaceDetails.airlineId,
        ticketId: ticker,
        flightEscrow: airPeaceDetails.flightEscrow,
        amount: totalAmount.toString(),
        ...args,
      }

      const booked = await context.prisma.booked.create({
        data: { ...bookedflightDetails },
      });

      // update user table
      const flight = await context.prisma.booked.findMany({
        where: {
          userId: userDetails.id
        }
      });
      const user = await context.prisma.user.findUnique({
        where: {
          id: userDetails.id
        }
      })
      const usTotalFee = user.totalFee || 0;
      const balanceWallet = await balanceOf(userDetails.addr)
      await context.prisma.user.update({
        where: {
          id: userDetails.id
        },
        data: {
          walletBalance: balanceWallet.data,
          numOfFlights: Object.keys(flight).length,
          totalFee: totalAmount + usTotalFee,
        }
      })

      //update booked db
      const bookUpdate = await context.prisma.booked.update({
        where: {
          ticketId: ticker
        },
        data: {
          apstatus: '2',
          status: 'ONGOING',
          amount: totalAmount.toString()
        },
      });

      //update flight db
      // add the total number of passengers (eg adults, children and infants who booked flight)

      const passengerCount = bookUpdate.numOfAdults + bookUpdate.numOfChildren + bookUpdate.numOfInfants

      const flightQuery = await context.prisma.flight.findUnique({
        where: {
          flightCode: args.flightCode
        }
      })

      const fqPass = flightQuery.pass || 0;
      const fqTotalFee = flightQuery.totalFee || 0;

      const flightUpdate = await context.prisma.flight.update({
        where: {
          flightCode: args.flightCode
        },
        data: {
          pass: passengerCount + fqPass,
          totalFee: totalAmount + fqTotalFee,
          status: 'ONGOING'
        }
      })

      console.log("flightUpdate", flightUpdate);
      // create wallet transaction

      await context.prisma.wallettransactions.create({
        data: {
          userId: userDetails.id,
          from: userDetails.email,
          fromAddr: userDetails.addr,
          receiverName: airPeaceDetails.airlineName,
          receiverAddr: airPeaceDetails.airlineAddres,
          amount: totalAmount,
          description: `Booking paid to: ${airPeaceDetails.airlineName}`,
          trxType: "Booking",
          status: "Completed"
        }
      });





      // percentage goes to airline wallet

      // const airlineDetails = await context.prisma.flight.findMany();
      // let result = airlineDetails.map(a => a.flightEscrow);  
      // const airline = await context.prisma.airline.findUnique({
      //   where: {
      //     id: airPeaceDetails.airlineId
      //   }
      // })

      // const pairAirline = await setAirlineKeypair(airline.email);
      // const { data: { flightEscrow } } = await airlineEscrow(airPeaceDetails.airlineAddres);
      // let flightesrwIndex = flightEscrow.indexOf(airPeaceDetails.flightEscrow);
      // const bookingClaimResult =
      // await airlineClaimBookingFee(airPeaceDetails.flightEscrow, flightesrwIndex, pairAirline.address, pairAirline.privateKey);

      await publishToQueue("bookedFlight", JSON.stringify(bookUpdate));
      await publishToQueue("updateFlight", JSON.stringify(flightUpdate));

      return {
        bookUpdate
      };

    } else {
      //call the last index in array checkBooked
      let checkBookedIndex = checkBooked[checkBooked.length - 1];

      if (checkBookedIndex.status === "ONGOING") {
        throw new ForbiddenError("Flight booked. Go to Paid Flights to view already paid flights..");
      }

      // check if user has enough balance
      const numOfChildren = args.numOfChildren || 0
      const numOfInfants = args.numOfInfants || 0

      const totalNumOfPassengers = args.numOfAdults + numOfChildren + numOfInfants;

      const totalAmount = totalNumOfPassengers * parseInt(args.amount)

      const userBalance = await balanceOf(userDetails.addr);

      if (parseInt(userBalance.data) < totalAmount) {
        throw new UserInputError('Insufficient funds. Fund your wallet. ');
      }

      // const escrowTransfer = await transferEscrow(
      //   airPeaceDetails.flightEscrow,
      //   airPeaceDetails.airlineAddres,
      //   pair.address,
      //   totalAmount.toString(),
      //   args.class,
      //   airPeaceDetails.apstatus,
      //   ticker,
      //   pair.privateKey
      // )

      // console.log("Transfer to escrow", escrowTransfer);

      const transferResult = await transfer(
        pair.address,
        pair.privateKey,
        airPeaceDetails.airlineAddres,
        totalAmount.toString()
      );

      console.log("Transfer to airline", transferResult);

      const bookedflightDetails = {
        userId: userDetails.id,
        userFirstName: userDetails.firstname,
        userLastName: userDetails.lastname,
        email: userDetails.email,
        airlineName: airPeaceDetails.airlineName,
        airlineAddres: airPeaceDetails.airlineAddres,
        departureInfo: airPeaceDetails.departureInfo,
        arrivalInfo: airPeaceDetails.arrivalInfo,
        airlineId: airPeaceDetails.airlineId,
        ticketId: ticker,
        flightEscrow: airPeaceDetails.flightEscrow,
        amount: totalAmount.toString(),
        ...args,
      }

      const booked = await context.prisma.booked.create({
        data: { ...bookedflightDetails },
      });

      // update user table
      const flight = await context.prisma.booked.findMany({
        where: {
          userId: userDetails.id
        }
      });
      const user = await context.prisma.user.findUnique({
        where: {
          id: userDetails.id
        }
      })
      const usTotalFee = user.totalFee || 0;
      const balanceWallet = await balanceOf(userDetails.addr)
      await context.prisma.user.update({
        where: {
          id: userDetails.id
        },
        data: {
          walletBalance: balanceWallet.data,
          numOfFlights: Object.keys(flight).length,
          totalFee: totalAmount + usTotalFee,
        }
      })

      //update booked db
      const bookUpdate = await context.prisma.booked.update({
        where: {
          ticketId: ticker
        },
        data: {
          apstatus: '2',
          status: 'ONGOING',
          amount: totalAmount.toString()
        },
      });

      //update flight db
      // add the total number of passengers (eg adults, children and infants who booked flight)

      const passengerCount = bookUpdate.numOfAdults + bookUpdate.numOfChildren + bookUpdate.numOfInfants

      const flightQuery = await context.prisma.flight.findUnique({
        where: {
          flightCode: args.flightCode
        }
      })

      const fqPass = flightQuery.pass || 0;
      const fqTotalFee = flightQuery.totalFee || 0;

      const flightUpdate = await context.prisma.flight.update({
        where: {
          flightCode: args.flightCode
        },
        data: {
          pass: passengerCount + fqPass,
          totalFee: totalAmount + fqTotalFee,
          status: 'ONGOING'
        }
      })

      console.log("flightUpdate", flightUpdate);
      // create wallet transaction

      await context.prisma.wallettransactions.create({
        data: {
          userId: userDetails.id,
          from: userDetails.email,
          fromAddr: userDetails.addr,
          receiverName: airPeaceDetails.airlineName,
          receiverAddr: airPeaceDetails.airlineAddres,
          amount: totalAmount,
          description: `Booking paid to: ${airPeaceDetails.airlineName}`,
          trxType: "Booking",
          status: "Completed"
        }
      });





      // percentage goes to airline wallet

      // const airlineDetails = await context.prisma.flight.findMany();
      // let result = airlineDetails.map(a => a.flightEscrow);  
      // const airline = await context.prisma.airline.findUnique({
      //   where: {
      //     id: airPeaceDetails.airlineId
      //   }
      // })

      // const pairAirline = await setAirlineKeypair(airline.email);
      // const { data: { flightEscrow } } = await airlineEscrow(airPeaceDetails.airlineAddres);
      // let flightesrwIndex = flightEscrow.indexOf(airPeaceDetails.flightEscrow);
      // const bookingClaimResult =
      // await airlineClaimBookingFee(airPeaceDetails.flightEscrow, flightesrwIndex, pairAirline.address, pairAirline.privateKey);

      await publishToQueue("bookedFlight", JSON.stringify(bookUpdate));
      await publishToQueue("updateFlight", JSON.stringify(flightUpdate));

      return {
        bookUpdate
      };

    }
  }
  else if (arikAirDetails !== undefined &&
    arikAirDetails.flightCode === args.flightCode) {

    // check if flight has already been booked

    const checkBooked = await context.prisma.booked.findMany({
      where: {
        userId: userDetails.id,
        flightCode: args.flightCode
      }
    });

    if (checkBooked == 0) {

      // check if user has enough balance
      const numOfChildren = args.numOfChildren || 0
      const numOfInfants = args.numOfInfants || 0

      const totalNumOfPassengers = args.numOfAdults + numOfChildren + numOfInfants;

      const totalAmount = totalNumOfPassengers * parseInt(args.amount)

      const userBalance = await balanceOf(userDetails.addr);

      if (parseInt(userBalance.data) < totalAmount) {
        throw new UserInputError('Insufficient funds. Fund your wallet. ');
      }

      // const escrowTransfer = await transferEscrow(
      //   arikAirDetails.flightEscrow,
      //   arikAirDetails.airlineAddres,
      //   pair.address,
      //   totalAmount.toString(),
      //   args.class,
      //   arikAirDetails.apstatus,
      //   ticker,
      //   pair.privateKey
      // )

      // console.log("Transfer to escrow", escrowTransfer);

      const transferResult = await transfer(
        pair.address,
        pair.privateKey,
        arikAirDetails.airlineAddres,
        totalAmount.toString()
      );

      console.log("Transfer to airline", transferResult);

      const bookedflightDetails = {
        userId: userDetails.id,
        userFirstName: userDetails.firstname,
        userLastName: userDetails.lastname,
        email: userDetails.email,
        airlineName: arikAirDetails.airlineName,
        airlineAddres: arikAirDetails.airlineAddres,
        departureInfo: arikAirDetails.departureInfo,
        arrivalInfo: arikAirDetails.arrivalInfo,
        airlineId: arikAirDetails.airlineId,
        ticketId: ticker,
        flightEscrow: arikAirDetails.flightEscrow,
        amount: totalAmount.toString(),
        ...args,
      }

      const booked = await context.prisma.booked.create({
        data: { ...bookedflightDetails },
      });

      // update user table
      const flight = await context.prisma.booked.findMany({
        where: {
          userId: userDetails.id
        }
      });
      const user = await context.prisma.user.findUnique({
        where: {
          id: userDetails.id
        }
      })
      const usTotalFee = user.totalFee || 0;
      const balanceWallet = await balanceOf(userDetails.addr)
      await context.prisma.user.update({
        where: {
          id: userDetails.id
        },
        data: {
          walletBalance: balanceWallet.data,
          numOfFlights: Object.keys(flight).length,
          totalFee: totalAmount + usTotalFee,
        }
      })

      //update booked db
      const bookUpdate = await context.prisma.booked.update({
        where: {
          ticketId: ticker
        },
        data: {
          apstatus: '2',
          status: 'ONGOING',
          amount: totalAmount.toString()
        },
      });

      //update flight db
      // add the total number of passengers (eg adults, children and infants who booked flight)

      const passengerCount = bookUpdate.numOfAdults + bookUpdate.numOfChildren + bookUpdate.numOfInfants

      const flightQuery = await context.prisma.flight.findUnique({
        where: {
          flightCode: args.flightCode
        }
      })

      const fqPass = flightQuery.pass || 0;
      const fqTotalFee = flightQuery.totalFee || 0;

      const flightUpdate = await context.prisma.flight.update({
        where: {
          flightCode: args.flightCode
        },
        data: {
          pass: passengerCount + fqPass,
          totalFee: totalAmount + fqTotalFee,
          status: 'ONGOING'
        }
      })

      console.log("flightUpdate", flightUpdate);
      // create wallet transaction

      await context.prisma.wallettransactions.create({
        data: {
          userId: userDetails.id,
          from: userDetails.email,
          fromAddr: userDetails.addr,
          receiverName: arikAirDetails.airlineName,
          receiverAddr: arikAirDetails.airlineAddres,
          amount: totalAmount,
          description: `Booking paid to: ${arikAirDetails.airlineName}`,
          trxType: "Booking",
          status: "Completed"
        }
      });





      // percentage goes to airline wallet

      // const airlineDetails = await context.prisma.flight.findMany();
      // let result = airlineDetails.map(a => a.flightEscrow);  
      // const airline = await context.prisma.airline.findUnique({
      //   where: {
      //     id: arikAirDetails.airlineId
      //   }
      // })

      // const pairAirline = await setAirlineKeypair(airline.email);
      // const { data: { flightEscrow } } = await airlineEscrow(arikAirDetails.airlineAddres);
      // let flightesrwIndex = flightEscrow.indexOf(arikAirDetails.flightEscrow);
      // const bookingClaimResult =
      // await airlineClaimBookingFee(arikAirDetails.flightEscrow, flightesrwIndex, pairAirline.address, pairAirline.privateKey);

      await publishToQueue("bookedFlight", JSON.stringify(bookUpdate));
      await publishToQueue("updateFlight", JSON.stringify(flightUpdate));

      return {
        bookUpdate
      };

    }
    else {
      //call the last index in array checkBooked
      let checkBookedIndex = checkBooked[checkBooked.length - 1];


      if (checkBookedIndex.status === "ONGOING") {
        throw new ForbiddenError("Flight booked. Go to Paid Flights to view already paid flights.");
      }

      // check if user has enough balance
      const numOfChildren = args.numOfChildren || 0
      const numOfInfants = args.numOfInfants || 0

      const totalNumOfPassengers = args.numOfAdults + numOfChildren + numOfInfants;

      const totalAmount = totalNumOfPassengers * parseInt(args.amount)

      const userBalance = await balanceOf(userDetails.addr);

      if (parseInt(userBalance.data) < totalAmount) {
        throw new UserInputError('Insufficient funds. Fund your wallet. ');
      }

      // const escrowTransfer = await transferEscrow(
      //   arikAirDetails.flightEscrow,
      //   arikAirDetails.airlineAddres,
      //   pair.address,
      //   totalAmount.toString(),
      //   args.class,
      //   arikAirDetails.apstatus,
      //   ticker,
      //   pair.privateKey
      // )

      // console.log("Transfer to escrow", escrowTransfer);

      const transferResult = await transfer(
        pair.address,
        pair.privateKey,
        arikAirDetails.airlineAddres,
        totalAmount.toString()
      );

      console.log("Transfer to airline", transferResult);

      const bookedflightDetails = {
        userId: userDetails.id,
        userFirstName: userDetails.firstname,
        userLastName: userDetails.lastname,
        email: userDetails.email,
        airlineName: arikAirDetails.airlineName,
        airlineAddres: arikAirDetails.airlineAddres,
        departureInfo: arikAirDetails.departureInfo,
        arrivalInfo: arikAirDetails.arrivalInfo,
        airlineId: arikAirDetails.airlineId,
        ticketId: ticker,
        flightEscrow: arikAirDetails.flightEscrow,
        amount: totalAmount.toString(),
        ...args,
      }

      const booked = await context.prisma.booked.create({
        data: { ...bookedflightDetails },
      });

      // update user table
      const flight = await context.prisma.booked.findMany({
        where: {
          userId: userDetails.id
        }
      });
      const user = await context.prisma.user.findUnique({
        where: {
          id: userDetails.id
        }
      })
      const usTotalFee = user.totalFee || 0;
      const balanceWallet = await balanceOf(userDetails.addr)
      await context.prisma.user.update({
        where: {
          id: userDetails.id
        },
        data: {
          walletBalance: balanceWallet.data,
          numOfFlights: Object.keys(flight).length,
          totalFee: totalAmount + usTotalFee,
        }
      })

      //update booked db
      const bookUpdate = await context.prisma.booked.update({
        where: {
          ticketId: ticker
        },
        data: {
          apstatus: '2',
          status: 'ONGOING',
          amount: totalAmount.toString()
        },
      });

      //update flight db
      // add the total number of passengers (eg adults, children and infants who booked flight)

      const passengerCount = bookUpdate.numOfAdults + bookUpdate.numOfChildren + bookUpdate.numOfInfants

      const flightQuery = await context.prisma.flight.findUnique({
        where: {
          flightCode: args.flightCode
        }
      })

      const fqPass = flightQuery.pass || 0;
      const fqTotalFee = flightQuery.totalFee || 0;

      const flightUpdate = await context.prisma.flight.update({
        where: {
          flightCode: args.flightCode
        },
        data: {
          pass: passengerCount + fqPass,
          totalFee: totalAmount + fqTotalFee,
          status: 'ONGOING'
        }
      })

      console.log("flightUpdate", flightUpdate);
      // create wallet transaction

      await context.prisma.wallettransactions.create({
        data: {
          userId: userDetails.id,
          from: userDetails.email,
          fromAddr: userDetails.addr,
          receiverName: arikAirDetails.airlineName,
          receiverAddr: arikAirDetails.airlineAddres,
          amount: totalAmount,
          description: `Booking paid to: ${arikAirDetails.airlineName}`,
          trxType: "Booking",
          status: "Completed"
        }
      });





      // percentage goes to airline wallet

      // const airlineDetails = await context.prisma.flight.findMany();
      // let result = airlineDetails.map(a => a.flightEscrow);  
      // const airline = await context.prisma.airline.findUnique({
      //   where: {
      //     id: arikAirDetails.airlineId
      //   }
      // })
      // const pairAirline = await setAirlineKeypair(airline.email);
      // const { data: { flightEscrow } } = await airlineEscrow(arikAirDetails.airlineAddres);
      // let flightesrwIndex = flightEscrow.indexOf(arikAirDetails.flightEscrow);
      // const bookingClaimResult =
      // await airlineClaimBookingFee(arikAirDetails.flightEscrow, flightesrwIndex, pairAirline.address, pairAirline.privateKey);

      await publishToQueue("bookedFlight", JSON.stringify(bookUpdate));
      await publishToQueue("updateFlight", JSON.stringify(flightUpdate));

      return {
        bookUpdate
      };

    }
  } else {
    throw new ForbiddenError("Sorry, no flights were found.");
  }
}


async function userBankDetails(parent, args, context, info) {


  const user = await getAUserById(context);


  const transaction = await context.prisma.usersbanklist.findMany({
    where: { userId: user.id }
  })

  if (transaction.length === 0) {
    const userDetails = {
      userId: user.id,
      acctResCountry: args.residentCountry,
      acctName: args.acctName,
      acctBank: args.acctBank,
      acctNumber: args.acctNumber,
      acctType: args.acctType,
      acctSwiftCode: args.acctSwiftCode
    }


    await context.prisma.usersbanklist.create({
      data: { ...userDetails },
    });

    return {
      status: "true",
      message: "User details successfully added"
    };
  }

  else {


    let result = transaction.map(a => a.acctNumber);


    const found = result.find(element => element == args.acctNumber);

    if (args.acctNumber == found) {

      throw new UserInputError('Account already exists');

    } else {

      const userDetails = {
        userId: user.id,
        acctResCountry: args.residentCountry,
        acctName: args.acctName,
        acctBank: args.acctBank,
        acctNumber: args.acctNumber,
        acctType: args.acctType,
        acctSwiftCode: args.acctSwiftCode
      }


      await context.prisma.usersbanklist.create({
        data: { ...userDetails },
      });

      return {
        status: "true",
        message: "User details successfully updated"
      };
    }

  }

}

async function redeemFiat(parent, args, context, info) {

  const tx_ref = uuid();

  const user = await getAUserById(context);

  const pair = await setUserKeypair(user.email);


  const userBank = await context.prisma.user.findUnique({
    where: {
      id: user.id
    },
    include: {
      userBankList: true,
    },
  })

  // map through and find account numbers
  let acct = userBank.userBankList.map(a => a);

  const acctFound = acct.find(({ acctNumber }) => acctNumber === args.accountToWithdraw);


  if (acctFound && args.accountToWithdraw == acctFound.acctNumber) {

    // verify users account
    const { status, data } = await verifyAccountNumber(acctFound.acctNumber, acctFound.acctBank);

    if (status == true) {

      const { status, data: { active, recipient_code } } =

        await transferRecipientCreation(data.account_name, data.account_number, acctFound.acctBank);

      if (status == true && active == true) {
        // check to ensure user doesn't input more than the amount in the balance

        const userBalance = await balanceOf(user.addr);

        if (parseInt(args.amount) > parseInt(userBalance.data)) {
          throw new UserInputError('You cannot withdraw an amount greater than your balance.');
        }
        const newAmountx = args.amount * 100;

        // transfer funds to users bank account
        const { status, data: { amount } } = await initiateTransfer(newAmountx, recipient_code)

        if (status !== true) {
          throw new ValidationError("Failed to complete transaction. Please try again.");
        }

        // transfer users tokens to Admin wallet

        const result = await transfer(
          pair.address,
          pair.privateKey,
          ADMIN_ADDRESS,
          args.amount)
        console.log(result);

        if (result.status !== "success") {

          throw new ValidationError("Failed to deduct user balance.");
        }

        const newWalletTrans = {
          userId: user.id,
          from: user.email,
          fromAddr: user.addr,
          receiverAddr: ADMIN_ADDRESS,
          amount: parseInt(args.amount),
          description: "Withdrawal to bank account",
          trxRef: tx_ref,
          trxType: "Withdrawal",
          status: "Completed"
        }

        await context.prisma.wallettransactions.create({
          data: { ...newWalletTrans },
        });

        // update user table
        const balanceWallet = await balanceOf(user.addr)
        const userDetail = await context.prisma.user.findUnique({
          where: {
            id: user.id
          }
        })
        const usTotalWithdraw = userDetail.totalWithdraws || 0;
        await context.prisma.user.update({
          where: {
            id: user.id
          },
          data: {
            walletBalance: balanceWallet.data,
            totalWithdraws: parseInt(args.amount) + usTotalWithdraw
          }
        })
        // // update user table
        // await context.prisma.user.update({
        //   where: {
        //     id: user.id
        //   },
        //   data: {
        //     walletBalance: balanceWallet.data,
        //   }
        // })

        return {
          status: "success",
          message: "Withdrawal operation complete."
        }

      }

      else {
        throw new ValidationError("Failed to create recipient. Please try again.");

      }

    } else {

      throw new ValidationError("Account Verification failed. Please check that the account is valid and try again.");

    }

  }
  else {
    throw new UserInputError('Account does not exist');
  }


}

async function transferToken(parent, args, context, info) {


  const tx_ref = uuid();

  const user = await getAUserById(context);

  const pair = await setUserKeypair(user.email);


  // check to ensure user doesn't input more than the amount in the balance

  const userBalance = await balanceOf(user.addr);

  if (parseInt(args.amount) > parseInt(userBalance.data)) {
    throw new UserInputError('You cannot transfer an amount greater than your balance.');
  }

  // commense transfer process
  const result = await transfer(
    pair.address,
    pair.privateKey,
    args.recipientAddress,
    args.amount
  );

  if (result.status !== "success") {

    throw new ValidationError("Failed to transfer tokens.");
  }

  const newWalletTrans = {
    userId: user.id,
    from: user.email,
    fromAddr: user.addr,
    receiverAddr: args.recipientAddress,
    amount: parseInt(args.amount),
    description: "Sent Token",
    trxRef: tx_ref,
    trxType: "Send",
    status: "Completed"
  }

  await context.prisma.wallettransactions.create({
    data: { ...newWalletTrans },
  });

  const balanceWallet = await balanceOf(user.addr)

  // update user table

  await context.prisma.user.update({
    where: {
      id: user.id
    },
    data: {
      walletBalance: balanceWallet.data,
    }
  })

  return {
    status: "success",
    message: "Transfer operation complete."
  }

}


async function cancelBookings(parent, args, context, info) {


  const user = await getAUserById(context);
  const azmanAirDetails = await getAzmanAirFlights(args, context);
  const airPeaceDetails = await getAirPeaceFlights(args, context);
  const arikAirDetails = await getArikAirFlights(args, context);

  const pair = await setUserKeypair(user.email);

    const balanceWalletOld = await balanceOf(user.addr)

    const oldWalletBalance = parseInt(balanceWalletOld.data);

    // get the data of the bookings made by passenger
    const bookedFlightDetails = await context.prisma.booked.findMany(
      {
        where: {
          userId: user.id,
          flightCode: args.flightCode
        }
      }
    );
    let acct = bookedFlightDetails.map(a => a);
    const bookedFlightDetail = acct.find(({ flightCode }) => flightCode === args.flightCode);

    console.log("bookedFlightDetail", bookedFlightDetail);
    
    // const cancelled = await cancelBooking(bookedFlightDetail.flightEscrow, pair.address, 0, pair.privateKey)

    // console.log("cancelled", cancelled);

    // if (cancelled.status !== "success") {

    //   throw new ValidationError("Failed to cancel booking");
    // }

    // const deleteClaims = await prisma.tempbookclaim.delete({
    //   where: {
    //     id: bookedClaim[i].id
    //   }
    // });

    const cancelDetails = {
      userId: user.id,
      // status: cancelled.status,
      status: "success",
      username: `${user.firstname} ${user.lastname}`,
      airlineName: bookedFlightDetail.airlineName,
      airlineId: bookedFlightDetail.airlineId,
      flightCode: bookedFlightDetail.flightCode,
      departureCity: bookedFlightDetail.departureCity,
      departureDate: bookedFlightDetail.departureDate,
      arrivalCity: bookedFlightDetail.arrivalCity,
      arrivalDate: bookedFlightDetail.arrivalDate,
      amount: bookedFlightDetail.amount,
      ticketId: bookedFlightDetail.ticketId
    }

    // update cancel db
    await context.prisma.passengercancel.create({
      data: { ...cancelDetails }
    });

        const cancellationList = await context.prisma.passengercancel.findMany({
          where: {
            userId: user.id,
            flightCode: args.flightCode
          }
        })
    
        let list = cancellationList.map(a => a);
        const cancelFound = list.find(({ flightCode }) => flightCode === args.flightCode);
    
        // get the flight info so you can compare dates for refunds
        const flightDetails = await context.prisma.flight.findUnique({
          where: {
            flightCode: args.flightCode
          }
        })
        const calculatedDays = calculateDays(cancelFound.createdAt, flightDetails.departureDate);
    
        console.log("cancelFound", cancelFound.createdAt)
        console.log("flightDetails", flightDetails.departureDate)
    
        console.log("canculatedDays", Math.round(calculatedDays));
    
        // refund passengers based on airlines refund policy
        var refundedAmount, amountRefund;
        if (cancelFound.airlineName == "Arik Air") {
          if (Math.round(calculatedDays) < 30) {
            refundedAmount = 90 * parseInt(cancelFound.amount) / 100
            const mintResult = await mintToken(refundedAmount, user.addr)
            console.log("minted Token", mintResult);
    
          } else if (Math.round(calculatedDays) >= 30 && Math.round(calculatedDays) < 60) {
            refundedAmount = 70 * parseInt(cancelFound.amount) / 100
            const mintResult = await mintToken(refundedAmount, user.addr)
            console.log("minted Token", mintResult);
          }
    
          // update the passengercancel db
           amountRefund = await context.prisma.passengercancel.update({
            where: {
              ticketId: bookedFlightDetail.ticketId
            },
            data: {
              amountRefunded: refundedAmount.toString()
            },
          });
          console.log("amountRefund", amountRefund)

        } else if (cancelFound.airlineName == "Air Peace") {
          if (Math.round(calculatedDays) < 30) {
            refundedAmount = 80 * parseInt(cancelFound.amount) / 100
            await mintToken(refundedAmount, user.addr)
          } else if (Math.round(calculatedDays) >= 30 && Math.round(calculatedDays) < 60) {
            refundedAmount = 60 * parseInt(cancelFound.amount) / 100
            await mintToken(refundedAmount, user.addr)
          }
    
          // update the passengercancel db
          amountRefund = await context.prisma.passengercancel.update({
            where: {
              ticketId: bookedFlightDetail.ticketId
            },
            data: {
              amountRefunded: refundedAmount.toString()
            },
          });

          console.log("amountRefund", amountRefund)
        }  else if (cancelFound.airlineName == "Azman Air") {
          if (Math.round(calculatedDays) < 30) {
            refundedAmount = 80 * parseInt(cancelFound.amount) / 100
            await mintToken(refundedAmount, user.addr)
          } else if (Math.round(calculatedDays) >= 30 && Math.round(calculatedDays) < 60) {
            refundedAmount = 60 * parseInt(cancelFound.amount) / 100
            await mintToken(refundedAmount, user.addr)
          }
    
          // update the passengercancel db
          amountRefund = await context.prisma.passengercancel.update({
            where: {
              ticketId: bookedFlightDetail.ticketId
            },
            data: {
              amountRefunded: refundedAmount.toString()
            },
          });

          console.log("amountRefund", amountRefund)
        }


    // update cancel field on booked db

    const foundUser = await context.prisma.booked.findMany(
      {
        where: {
          email: user.email,
        }
      }
    );

    let foundLoop = foundUser.map(a => a);

    const found = foundLoop.find(({ flightCode }) => flightCode === args.flightCode);


    const bookCancelUpdate = await context.prisma.booked.update({
      where: {
        ticketId: found.ticketId
      },
      data: {
        cancelled: true
      },
    });

    // update number of cancelled users on flight db
    const flightQuery = await context.prisma.flight.findUnique({
      where: {
        flightCode: args.flightCode
      }
    })

    const fqPass = flightQuery.cancelled || 0;

    const cancelCount = await context.prisma.flight.update({
      where: {
        flightCode: args.flightCode
      },
      data: {
        cancelled: fqPass + 1
      }
    })

    //update user db for number of refunds

    const refund = await context.prisma.passengercancel.findMany({
      where: {
        userId: user.id
      }
    });
    // const userDetails = await context.prisma.user.findUnique({
    //   where: {
    //     id: user.id
    //   }
    // })

    const usTotalFee = user.totalRefunds || 0;
    const balanceWalletNew = await balanceOf(user.addr)

    const newWalletBalance = parseInt(balanceWalletNew.data);

    await context.prisma.user.update({
      where: {
        id: user.id
      },
      data: {
        walletBalance: balanceWalletNew.data,
        numOfRefunds: Object.keys(refund).length,
        totalRefunds: usTotalFee + (newWalletBalance - oldWalletBalance)
      }
    })



    await publishToQueue("cancelUpdate", JSON.stringify(bookCancelUpdate));
    await publishToQueue("cancelCount", JSON.stringify(cancelCount));
    await publishToQueue("cancellationList", JSON.stringify(amountRefund));

    return {
      status: "success",
      message: "Cancel operation successful."
    }

  // } else {
  //   throw new ValidationError("Airline is yet to claim this flight. Please try again later.");

  // }

  // }
}

function calculateDays(startDate,endDate)
{
   var start_date = moment(startDate, 'YYYY-MM-DD HH:mm:ss');
   var end_date = moment(endDate, 'YYYY-MM-DD HH:mm:ss');
   var duration = moment.duration(end_date.diff(start_date));
   var days = duration.asDays();       
   return days;
}



async function checkIn(parent, args, context, info) {

  const user = await getAUserById(context);

  const pair = await setUserKeypair(user.email);


  const bookedFlightDetails = await context.prisma.booked.findMany(
    {
      where: {
        flightCode: args.flightCode
      }
    }
  );

  let acct = bookedFlightDetails.map(a => a);

  const bookedFlightDetail = acct.find(({ flightCode }) => flightCode === args.flightCode);


  // const checkIn = await passengerCheckIn(bookedFlightDetail.flightEscrow, pair.address, 0, pair.privateKey)

  // console.log("check in", checkIn);

  // if (checkIn.status !== "success") {

  //   throw new ValidationError("Failed to check In. Please try again");
  // }

  const checkinDetails = {
    userId: user.id,
    status: "successs",
    username: `${user.firstname} ${user.lastname}`,
    airlineName: bookedFlightDetail.airlineName,
    flightCode: bookedFlightDetail.flightCode,
    departureCity: bookedFlightDetail.departureCity,
    departureDate: bookedFlightDetail.departureDate,
    arrivalCity: bookedFlightDetail.arrivalCity,
    arrivalDate: bookedFlightDetail.arrivalDate,
    ticketId: bookedFlightDetail.ticketId
  }

  // update checkin db
  await context.prisma.passengercheckin.create({
    data: { ...checkinDetails }
  });


  // update checkIn field on booked db

  const foundUser = await context.prisma.booked.findMany(
    {
      where: {
        email: user.email,
      }
    }
  );

  let foundLoop = foundUser.map(a => a);

  const found = foundLoop.find(({ flightCode }) => flightCode === args.flightCode);


  const bookCheckInUpdate = await context.prisma.booked.update({
    where: {
      ticketId: found.ticketId
    },
    data: {
      checkedIn: true
    },
  });


  // update number of checked in users on flight db
  const flightQuery = await context.prisma.flight.findUnique({
    where: {
      flightCode: args.flightCode
    }
  })

  const fqPass = flightQuery.checkedIn || 0;

  const checkInCount = await context.prisma.flight.update({
    where: {
      flightCode: args.flightCode
    },
    data: {
      checkedIn: fqPass + 1
    }
  })


  await publishToQueue("checkIn", JSON.stringify(bookCheckInUpdate));
  await publishToQueue("checkInCount", JSON.stringify(checkInCount));


  const result = await sendItinerary(
    user.firstname,
    user.lastname,
    bookedFlightDetail.airlineName,
    user.email,
    bookedFlightDetail.flightCode,
    bookedFlightDetail.departureCity,
    bookedFlightDetail.departureDate,
    bookedFlightDetail.departureTime,
    bookedFlightDetail.arrivalCity,
    bookedFlightDetail.arrivalDate,
    bookedFlightDetail.arrivalTime,
    bookedFlightDetail.class,
    bookedFlightDetail.ticketId,
    bookedFlightDetail.status
  )




     const pubsubRes = await context.pubsub.publish('CHECKIN_CREATED', {
      checkinCreated: {
      userId: user.id,
      status: "success",
      username: `${user.firstname} ${user.lastname}`,
      airlineName: bookedFlightDetail.airlineName,
      flightCode: bookedFlightDetail.flightCode,
      departureCity: bookedFlightDetail.departureCity,
      departureDate: bookedFlightDetail.departureDate,
      arrivalCity: bookedFlightDetail.arrivalCity,
      arrivalDate: bookedFlightDetail.arrivalDate,
      ticketId: bookedFlightDetail.arrivalTime
    } 
  })

  return {
    ...checkinDetails
  }
  //     } else {
  //       throw new ValidationError("Airline is yet to claim this flight. Please try again later.");

  //     }
  //   }


}

async function getDepositQRCode(parent, args, context, info) {
  const user = await getAUserById(context);
  const pair = await setUserKeypair(user.email);
  const data = await generateCryptoDepositQRCode(pair.address);

  return {
    status: "success",
    message: "Transaction fetched successfully",
    data: data.qrCode
  }
}































































const fakeData = {
  // firstname: "Joel",
  // lastname: "Dara",
  // email: "sola103@mailcuk.com",
  // mobile: "2347040247157",
  // password: "12345678"


  firstname: "Joel",
  lastname: "Man",
  email: "jayjosh846@gmail.com",
  mobile: "2349036075477",
  password: "12345678"

}

async function signupPayment(parent, args, context, info) {
  let flightCodeGenerator = Math.random().toString(36).substring(7, 11);

  const isUniqueUser = await isEmailOrMobileExist(args, context);

  const unique = await context.prisma.user.findMany()



  let result = unique.map(a => a.email);
  const found = result.find(element => element === args.email);

  if (args.email === found) {
    throw new UserInputError('Email or mobile already exists');
  }

  let resultMobile = unique.map(a => a.mobile);
  const foundMobile = resultMobile.find(element => element === args.mobile);

  if (args.mobile === foundMobile) {
    throw new UserInputError('Email or mobile already exists');
  }


  // if (isUniqueUser) {
  //   throw new UserInputError('Email or mobile already exists');
  // } 


  const termiResponse = await sendOTP(args.mobile);
  const { pinId, smsStatus, to } = termiResponse;
  console.log("pinId, smsStatus, to", pinId, smsStatus, to);
  const cached = await cache.setCacheWithExpiration(
    args.mobile,
    1440,
    JSON.stringify(termiResponse)
  );
  if (cached === "OK") {
    const password = await bcrypt.hash(flightCodeGenerator, 10);
    const pair = await setUserKeypair(args.email);
    const user = await context.prisma.user.create({
      data: { ...args, password, addr: pair.address },
    });

    const addToList = await addUserList(pair.address);
    console.log("addUserList", addToList);

    const token = jwt.sign({ userId: user.id }, JWT_SECRET);
    return {
      token,
      user,
      smsTokenStatus: smsStatus,
    };
  }

  // const password = await bcrypt.hash(args.password, 10);
  // const user = await context.prisma.user.create({
  //   data: { ...args, password },
  // });
  // const token = jwt.sign({ userId: user.id }, JWT_SECRET);
  // return {
  //   token,
  //   user,
  //   smsTokenStatus: smsStatus,
  // };

}




async function signupAnd2FAPayment(parent, args, context, info) {

  const unique = await context.prisma.fakedata.findMany({
    where: {
      email: fakeData.email
    }
  })

  let result = unique.map(a => a);
  const found = result.find(({ email }) => email === fakeData.email);

  const termiResponse = await sendOTP(found.mobile);
  const { pinId, smsStatus, to } = termiResponse;
  const cached = await cache.setCacheWithExpiration(
    found.mobile,
    1440,
    JSON.stringify(termiResponse)
  );
  if (cached === "OK") {
    return {
      status: true,
      message: "Token sent"

    }
  }
}




async function authPayment(parent, args, context, info) {

  await context.prisma.fakedata.create({
    data: {
      ...fakeData
    },
  });


  const user = await context.prisma.user.findUnique({
    where: { email: fakeData.email },
  });
  if (!user) {
    return {
      status: false,
      message: "No user found"
    }
  }
  // if (user.role === "ADMIN")
  // {
  //   throw new AuthenticationError("You are an admin. Login through the admin dashboard");

  // }

  const termiResponse = await sendOTP(fakeData.mobile);
  const { pinId, smsStatus, to } = termiResponse;
  const cached = await cache.setCacheWithExpiration(
    fakeData.mobile,
    1440,
    JSON.stringify(termiResponse)
  );
  if (cached === "OK") {
    // const token = jwt.sign({ userId: user.id }, JWT_SECRET);
    return {
      status: true,
      message: "User found"

    }
  }
}

async function verifyMobilePayment(parent, args, context, info) {
  const result = await cache.getCachedItem(args.msisdn);
  if (!result) {

    throw new AuthenticationError("Invalid number");
  }

  const { pinId } = JSON.parse(result);
  const termiResponse = await verifyOTP(pinId, args.pin);

  if (
    termiResponse.verified === false ||
    termiResponse.verified === "Expired" ||
    termiResponse.status == 400
  ) {


    throw new UserInputError('Invalid code entered', {
      argumentName: 'pin'
    });


  } else if (termiResponse.status == 200 || termiResponse.verified) {
    console.log('token', termiResponse);

    const user = await context.prisma.user.findUnique({
      where: {
        mobile: args.msisdn
      },
    });

    const token = jwt.sign({ userId: user.id }, JWT_SECRET);

    await context.prisma.fakedata.deleteMany({})

    return {
      token,
      user,
    };
  }
}

async function verifyNewUserPayment(parent, args, context, info) {
  let flightCodeGenerator = Math.random().toString(36).substring(7, 11);
  const unique = await context.prisma.fakedata.findMany({
    where: {
      email: fakeData.email
    }
  })

  let results = unique.map(a => a);
  const found = results.find(({ email }) => email === fakeData.email);


  const result = await cache.getCachedItem(args.msisdn);
  if (!result) {

    throw new AuthenticationError("Invalid number");
  }

  const { pinId } = JSON.parse(result);
  const termiResponse = await verifyOTP(pinId, args.pin);

  if (
    termiResponse.verified === false ||
    termiResponse.verified === "Expired" ||
    termiResponse.status == 400
  ) {


    throw new UserInputError('Invalid code entered', {
      argumentName: 'pin'
    });


  } else if (termiResponse.status == 200 || termiResponse.verified) {
    console.log('token', termiResponse);

    const password = await bcrypt.hash(flightCodeGenerator, 10);
    const pair = await setUserKeypair(found.email);
    const userCreate = await context.prisma.user.create({
      data: {
        email: found.email,
        firstname: found.firstname,
        lastname: found.lastname,
        password: password,
        mobile: found.mobile,
        addr: pair.address
      },
    });

    const addToList = await addUserList(pair.address);
    console.log("addUserList", addToList);

    const user = await context.prisma.user.update({
      where: {
        mobile: args.msisdn,
      },
      data: {
        // addr,
        // pvtKey,
        mobileVerified: true
      },
    });

    const token = jwt.sign({ userId: userCreate.id }, JWT_SECRET);

    await context.prisma.fakedata.deleteMany({})

    return {
      token,
      user,
    };
  }
}







async function bookFlightPayment(parent, args, context, info) {

  const userDetails = await getAUserById(context);

  const danaAir = await getDanaAir(args, context);
  const airPeace = await getAirPeace(args, context);
  const arikAir = await getArikAir(args, context);

  const azmanAirDetails = await getAzmanAirFlights(args, context);
  const airPeaceDetails = await getAirPeaceFlights(args, context);
  const arikAirDetails = await getArikAirFlights(args, context);
  const pair = await setUserKeypair(userDetails.email);



  let flightCodeGenerator = Math.floor(Math.random() * 1000000);
  let ticker = "";

  ticker = "TK" + flightCodeGenerator;

  // If Dana 

  if (azmanAirDetails !== undefined &&
    azmanAirDetails.flightCode === args.flightCode) {


    // check if user has enough balance
    const numOfChildren = args.numOfChildren || 0
    const numOfInfants = args.numOfInfants || 0

    const totalNumOfPassengers = args.numOfAdults + numOfChildren + numOfInfants;

    const totalAmount = totalNumOfPassengers * parseInt(args.amount)

    const userBalance = await balanceOf(userDetails.addr);

    if (parseInt(userBalance.data) < totalAmount) {
      throw new UserInputError('Insufficient funds. Fund your wallet. ');
    }

    // const escrowTransfer = await transferEscrowPayment(
    //   azmanAirDetails.flightEscrow,
    //   azmanAirDetails.airlineAddres,
    //   pair.address,
    //   totalAmount.toString(),
    //   args.class,
    //   azmanAirDetails.apstatus,
    //   ticker,
    //   pair.privateKey
    // )

    // console.log("Transfer to escrow", escrowTransfer);


    const transferResult = await transfer(
      pair.address,
      pair.privateKey,
      azmanAirDetails.airlineAddres,
      totalAmount.toString()
    );

    console.log("Transfer to airline", transferResult);

    const bookedflightDetails = {
      userId: userDetails.id,
      userFirstName: userDetails.firstname,
      userLastName: userDetails.lastname,
      email: userDetails.email,
      airlineName: azmanAirDetails.airlineName,
      airlineAddres: azmanAirDetails.airlineAddres,
      departureInfo: azmanAirDetails.departureInfo,
      arrivalInfo: azmanAirDetails.arrivalInfo,
      airlineId: azmanAirDetails.airlineId,
      ticketId: ticker,
      flightEscrow: azmanAirDetails.flightEscrow,
      amount: totalAmount.toString(),
      ...args,
    }

    const booked = await context.prisma.booked.create({
      data: { ...bookedflightDetails },
    });

    // update user table
    const flight = await context.prisma.booked.findMany({
      where: {
        userId: userDetails.id
      }
    });
    const user = await context.prisma.user.findUnique({
      where: {
        id: userDetails.id
      }
    })
    const usTotalFee = user.totalFee || 0;
    const balanceWallet = await balanceOf(userDetails.addr)
    await context.prisma.user.update({
      where: {
        id: userDetails.id
      },
      data: {
        walletBalance: balanceWallet.data,
        numOfFlights: Object.keys(flight).length,
        totalFee: totalAmount + usTotalFee,
      }
    })
    //update booked db
    const bookUpdate = await context.prisma.booked.update({
      where: {
        ticketId: ticker
      },
      data: {
        apstatus: '2',
        status: 'ONGOING',
        amount: totalAmount.toString(),
      },
    });

    //update flight db
    // add the total number of passengers (eg adults, children and infants who booked flight)

    const passengerCount = bookUpdate.numOfAdults + bookUpdate.numOfChildren + bookUpdate.numOfInfants

    const flightQuery = await context.prisma.flight.findUnique({
      where: {
        flightCode: args.flightCode
      }
    })

    const fqPass = flightQuery.pass || 0;
    const fqTotalFee = flightQuery.totalFee || 0;

    const flightUpdate = await context.prisma.flight.update({
      where: {
        flightCode: args.flightCode
      },
      data: {
        pass: passengerCount + fqPass,
        totalFee: totalAmount + fqTotalFee,
        status: 'ONGOING'
      }
    })

    console.log("flightUpdate", flightUpdate);
    // create wallet transaction

    await context.prisma.wallettransactions.create({
      data: {
        userId: userDetails.id,
        from: userDetails.email,
        fromAddr: userDetails.addr,
        receiverName: azmanAirDetails.airlineName,
        receiverAddr: azmanAirDetails.airlineAddres,
        amount: totalAmount,
        description: `Booking paid to: ${azmanAirDetails.airlineName}`,
        trxType: "Booking",
        status: "Completed"
      }
    });





    // percentage goes to airline wallet

    // const airlineDetails = await context.prisma.flight.findMany();
    // let result = airlineDetails.map(a => a.flightEscrow);  
    // const airline = await context.prisma.airline.findUnique({
    //   where: {
    //     id: azmanAirDetails.airlineId
    //   }
    // })

    // const pairAirline = await setAirlineKeypair(airline.email);
    // const { data: { flightEscrow } } = await airlineEscrow(azmanAirDetails.airlineAddres);
    // let flightesrwIndex = flightEscrow.indexOf(azmanAirDetails.flightEscrow);
    // const bookingClaimResult =
    // await airlineClaimBookingFee(azmanAirDetails.flightEscrow, flightesrwIndex, pairAirline.address, pairAirline.privateKey);

    await publishToQueue("bookedFlight", JSON.stringify(bookUpdate));
    await publishToQueue("updateFlight", JSON.stringify(flightUpdate));

    return {
      bookUpdate
    };
  }

  else if (airPeaceDetails !== undefined &&
    airPeaceDetails.flightCode === args.flightCode) {

    // check if user has enough balance
    const numOfChildren = args.numOfChildren || 0
    const numOfInfants = args.numOfInfants || 0

    const totalNumOfPassengers = args.numOfAdults + numOfChildren + numOfInfants;

    const totalAmount = totalNumOfPassengers * parseInt(args.amount)

    const userBalance = await balanceOf(userDetails.addr);

    if (parseInt(userBalance.data) < totalAmount) {
      throw new UserInputError('Insufficient funds. Fund your wallet. ');
    }

    // const escrowTransfer = await transferEscrow(
    //   airPeaceDetails.flightEscrow,
    //   airPeaceDetails.airlineAddres,
    //   pair.address,
    //   totalAmount.toString(),
    //   args.class,
    //   airPeaceDetails.apstatus,
    //   ticker,
    //   pair.privateKey
    // )

    // console.log("Transfer to escrow", escrowTransfer);

    const transferResult = await transfer(
      pair.address,
      pair.privateKey,
      airPeaceDetails.airlineAddres,
      totalAmount.toString()
    );

    console.log("Transfer to airline", transferResult);

    const bookedflightDetails = {
      userId: userDetails.id,
      userFirstName: userDetails.firstname,
      userLastName: userDetails.lastname,
      email: userDetails.email,
      airlineName: airPeaceDetails.airlineName,
      airlineAddres: airPeaceDetails.airlineAddres,
      departureInfo: airPeaceDetails.departureInfo,
      arrivalInfo: airPeaceDetails.arrivalInfo,
      airlineId: airPeaceDetails.airlineId,
      ticketId: ticker,
      flightEscrow: airPeaceDetails.flightEscrow,
      amount: totalAmount.toString(),
      ...args,
    }

    const booked = await context.prisma.booked.create({
      data: { ...bookedflightDetails },
    });

    // update user table
    const flight = await context.prisma.booked.findMany({
      where: {
        userId: userDetails.id
      }
    });
    const user = await context.prisma.user.findUnique({
      where: {
        id: userDetails.id
      }
    })
    const usTotalFee = user.totalFee || 0;
    const balanceWallet = await balanceOf(userDetails.addr)
    await context.prisma.user.update({
      where: {
        id: userDetails.id
      },
      data: {
        walletBalance: balanceWallet.data,
        numOfFlights: Object.keys(flight).length,
        totalFee: totalAmount + usTotalFee,
      }
    })

    //update booked db
    const bookUpdate = await context.prisma.booked.update({
      where: {
        ticketId: ticker
      },
      data: {
        apstatus: '2',
        status: 'ONGOING',
        amount: totalAmount.toString()
      },
    });

    //update flight db
    // add the total number of passengers (eg adults, children and infants who booked flight)

    const passengerCount = bookUpdate.numOfAdults + bookUpdate.numOfChildren + bookUpdate.numOfInfants

    const flightQuery = await context.prisma.flight.findUnique({
      where: {
        flightCode: args.flightCode
      }
    })

    const fqPass = flightQuery.pass || 0;
    const fqTotalFee = flightQuery.totalFee || 0;

    const flightUpdate = await context.prisma.flight.update({
      where: {
        flightCode: args.flightCode
      },
      data: {
        pass: passengerCount + fqPass,
        totalFee: totalAmount + fqTotalFee,
        status: 'ONGOING'
      }
    })

    console.log("flightUpdate", flightUpdate);
    // create wallet transaction

    await context.prisma.wallettransactions.create({
      data: {
        userId: userDetails.id,
        from: userDetails.email,
        fromAddr: userDetails.addr,
        receiverName: airPeaceDetails.airlineName,
        receiverAddr: airPeaceDetails.airlineAddres,
        amount: totalAmount,
        description: `Booking paid to: ${airPeaceDetails.airlineName}`,
        trxType: "Booking",
        status: "Completed"
      }
    });





    // percentage goes to airline wallet

    // const airlineDetails = await context.prisma.flight.findMany();
    // let result = airlineDetails.map(a => a.flightEscrow);  
    // const airline = await context.prisma.airline.findUnique({
    //   where: {
    //     id: airPeaceDetails.airlineId
    //   }
    // })

    // const pairAirline = await setAirlineKeypair(airline.email);
    // const { data: { flightEscrow } } = await airlineEscrow(airPeaceDetails.airlineAddres);
    // let flightesrwIndex = flightEscrow.indexOf(airPeaceDetails.flightEscrow);
    // const bookingClaimResult =
    // await airlineClaimBookingFee(airPeaceDetails.flightEscrow, flightesrwIndex, pairAirline.address, pairAirline.privateKey);

    await publishToQueue("bookedFlight", JSON.stringify(bookUpdate));
    await publishToQueue("updateFlight", JSON.stringify(flightUpdate));

    return {
      bookUpdate
    };

  }

  else if (arikAirDetails !== undefined &&
    arikAirDetails.flightCode === args.flightCode) {


    // check if user has enough balance
    const numOfChildren = args.numOfChildren || 0
    const numOfInfants = args.numOfInfants || 0

    const totalNumOfPassengers = args.numOfAdults + numOfChildren + numOfInfants;

    const totalAmount = totalNumOfPassengers * parseInt(args.amount)

    const userBalance = await balanceOf(userDetails.addr);

    if (parseInt(userBalance.data) < totalAmount) {
      throw new UserInputError('Insufficient funds. Fund your wallet. ');
    }

    // const escrowTransfer = await transferEscrow(
    //   arikAirDetails.flightEscrow,
    //   arikAirDetails.airlineAddres,
    //   pair.address,
    //   totalAmount.toString(),
    //   args.class,
    //   arikAirDetails.apstatus,
    //   ticker,
    //   pair.privateKey
    // )

    // console.log("Transfer to escrow", escrowTransfer);

    const transferResult = await transfer(
      pair.address,
      pair.privateKey,
      arikAirDetails.airlineAddres,
      totalAmount.toString()
    );

    console.log("Transfer to airline", transferResult);

    const bookedflightDetails = {
      userId: userDetails.id,
      userFirstName: userDetails.firstname,
      userLastName: userDetails.lastname,
      email: userDetails.email,
      airlineName: arikAirDetails.airlineName,
      airlineAddres: arikAirDetails.airlineAddres,
      departureInfo: arikAirDetails.departureInfo,
      arrivalInfo: arikAirDetails.arrivalInfo,
      airlineId: arikAirDetails.airlineId,
      ticketId: ticker,
      flightEscrow: arikAirDetails.flightEscrow,
      amount: totalAmount.toString(),
      ...args,
    }

    const booked = await context.prisma.booked.create({
      data: { ...bookedflightDetails },
    });

    // update user table
    const flight = await context.prisma.booked.findMany({
      where: {
        userId: userDetails.id
      }
    });
    const user = await context.prisma.user.findUnique({
      where: {
        id: userDetails.id
      }
    })
    const usTotalFee = user.totalFee || 0;
    const balanceWallet = await balanceOf(userDetails.addr)
    await context.prisma.user.update({
      where: {
        id: userDetails.id
      },
      data: {
        walletBalance: balanceWallet.data,
        numOfFlights: Object.keys(flight).length,
        totalFee: totalAmount + usTotalFee,
      }
    })

    //update booked db
    const bookUpdate = await context.prisma.booked.update({
      where: {
        ticketId: ticker
      },
      data: {
        apstatus: '2',
        status: 'ONGOING',
        amount: totalAmount.toString()
      },
    });

    //update flight db
    // add the total number of passengers (eg adults, children and infants who booked flight)

    const passengerCount = bookUpdate.numOfAdults + bookUpdate.numOfChildren + bookUpdate.numOfInfants

    const flightQuery = await context.prisma.flight.findUnique({
      where: {
        flightCode: args.flightCode
      }
    })

    const fqPass = flightQuery.pass || 0;
    const fqTotalFee = flightQuery.totalFee || 0;

    const flightUpdate = await context.prisma.flight.update({
      where: {
        flightCode: args.flightCode
      },
      data: {
        pass: passengerCount + fqPass,
        totalFee: totalAmount + fqTotalFee,
        status: 'ONGOING'
      }
    })

    console.log("flightUpdate", flightUpdate);
    // create wallet transaction

    await context.prisma.wallettransactions.create({
      data: {
        userId: userDetails.id,
        from: userDetails.email,
        fromAddr: userDetails.addr,
        receiverName: arikAirDetails.airlineName,
        receiverAddr: arikAirDetails.airlineAddres,
        amount: totalAmount,
        description: `Booking paid to: ${arikAirDetails.airlineName}`,
        trxType: "Booking",
        status: "Completed"
      }
    });





    // percentage goes to airline wallet

    // const airlineDetails = await context.prisma.flight.findMany();
    // let result = airlineDetails.map(a => a.flightEscrow);  
    // const airline = await context.prisma.airline.findUnique({
    //   where: {
    //     id: arikAirDetails.airlineId
    //   }
    // })
    // const pairAirline = await setAirlineKeypair(airline.email);
    // const { data: { flightEscrow } } = await airlineEscrow(arikAirDetails.airlineAddres);
    // let flightesrwIndex = flightEscrow.indexOf(arikAirDetails.flightEscrow);
    // const bookingClaimResult =
    // await airlineClaimBookingFee(arikAirDetails.flightEscrow, flightesrwIndex, pairAirline.address, pairAirline.privateKey);

    await publishToQueue("bookedFlight", JSON.stringify(bookUpdate));
    await publishToQueue("updateFlight", JSON.stringify(flightUpdate));

    return {
      bookUpdate
    };
  }

  else {
    throw new ForbiddenError("Sorry, no flights were found.");
  }
}




module.exports = {
  signup,
  login,
  sendEmailOTP,
  verifyMobileWithTermiiToken,
  sendTermiiTokenToMobile,
  makePayment,
  mint,
  bookFlight,
  userBankDetails,
  redeemFiat,
  transferToken,
  cancelBookings,
  checkIn,
  sendEmailVerification,
  verifyUser,
  resetPasswordRequest,
  resetPassword,
  getDepositQRCode,












  signupPayment,
  signupAnd2FAPayment,
  authPayment,
  verifyMobilePayment,
  verifyNewUserPayment,
  bookFlightPayment
  // verifyMobileWithTermiiTokenPayment,
  // makePaymentPayment,
  // balance  
  // transferToEscrow
};







