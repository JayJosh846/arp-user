const ethers = require("ethers");
const crypto = require("crypto")
const sha256 = require('simple-sha256')
const { createPassenger } = require('../web3Services/web3.services');

const Wallet = ethers.Wallet;


// Create a new BSC Account
 const createNewBSCAccount = async ({ mnemonicString, userSalt }) => {
    let hash = sha256.sync(mnemonicString);
    let salt = userSalt;
    let buffer = crypto.scryptSync(hash, salt, 32, {
      N: Math.pow(2, 14),
      r: 8,
      p: 1,
    });

    const generatedKeyPair = new Wallet(buffer);
    // const generatedKeyPair = await createPassenger(buffer)
    return generatedKeyPair;
  };

  module.exports = {
      createNewBSCAccount
  }
