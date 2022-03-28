require('dotenv').config();
const router = require('express').Router();
const helpers = require('../helpers');
const middleware = require('../middleware');
const fs = require('fs');
const BadWordList = JSON.parse(fs.readFileSync('./data/external/badwords-master/array.json'));
const sanitize = require('sanitize-filename');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { PullPlayerData } = require('../helpers');

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const client = require('twilio')(accountSid, authToken);

router.post('/enable-2fa', middleware.authenticateToken, async (req, res) => {
     try {
          const data = helpers.PullPlayerData(req.user.id);
          if(data.auth.mfa_enabled || data.auth.mfa_enabled == "unverified") return res.status(400).send("Two factor authentication is already enabled on this account!");

          client.verify.services(process.env.TWILIO_SERVICE_SID)
                    .entities(`COMPENSATION-VR-ACCOUNT-ID-${req.user.id}`)
                    .newFactors
                    .create({
                         friendlyName: `${data.public.username}`,
                         factorType: 'totp'
                    })
                    .then(new_factor => {
                         res.status(200).send(new_factor.binding);
                         data.auth.mfa_enabled = "unverified";
                         data.auth.mfa_factor_sid = new_factor.sid;
                         helpers.PushPlayerData(req.user.id, data);
                    });
     }
     catch (ex) {
          res.status(500).send("Failed to enable MFA.");
          throw ex;
     }
});

router.post('/verify-2fa', middleware.authenticateToken, async (req, res) => {
     var {code} = req.body;
     if(typeof code !== 'string') return res.status(400).send("Your 2FA code is undefined or is not a string. Check your Content-Type header and request body.");

     var _data = PullPlayerData(req.user.id);
     if(_data.auth.mfa_enabled !== 'unverified') return res.status(400).send("Your account is not currently awaiting verification.");

     Verify2faUser(req.user.id, code, success => {
          if(success) {
               var data = helpers.PullPlayerData(req.user.id);
               data.auth.mfa_enabled = true;
               helpers.PushPlayerData(req.user.id, data);

               return res.sendStatus(200);
          }
          else return res.status(401).send("Failed to verify code. Please double check you entered a fully up to date token.");
     });
});

router.post('/remove-2fa', middleware.authenticateToken, async (req, res) => {
     var data = PullPlayerData(req.user.id);

     if(!data.auth.mfa_enabled) return res.status(400).send("Your account does not have 2FA enabled or pending.");

     data.auth.mfa_enabled = false;
     data.auth.mfa_factor_sid = "undefined";

     helpers.PushPlayerData(req.user.id, data);
     res.sendStatus(200);
});

//Call to get a token from user account credentials.
router.post("/login", (req, res) => {
     //so first things first we need to check the username and password
     //and if those are correct we generate a token

     const { username, password, two_factor_code, hwid} = req.body;

     const userID = helpers.getUserID(username);
     if(userID == null) return res.status(404).send({message: "User not found!", failureCode: "5"});

     //now we read the correct user file for the authorization data
     const data = helpers.PullPlayerData(userID);


     const { HASHED_PASSWORD, salt } = data.auth;

     const externalHashed = bcrypt.hashSync(password, salt);

     if(externalHashed !== HASHED_PASSWORD) return res.status(403).send({message: "Incorrect password!", failureCode: "6"});

     for (let index = 0; index < data.auth.bans.length; index++) {
          const element = data.auth.bans[index];
          
          if(element.endTS > Date.now()) return res.status(403).send({
               message: "USER IS BANNED", 
               endTimeStamp: element.endTS, 
               reason: element.reason,
               failureCode: "7"
          });
     }
     
     //User is authenticated, generate and send token.

     const developer = data.private.availableTags.includes("Developer");

     const user = {username: username, id: userID, developer: developer};

     const accessToken = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, { expiresIn: "30m" });

     if(typeof data.auth.mfa_enabled == 'boolean' && !data.auth.mfa_enabled) return res.status(200).json({ userID: userID, username: username, accessToken: accessToken});

     if(typeof data.auth.mfa_enabled == 'string' && data.auth.mfa_enabled == 'unverified') {
          if(developer) return res.status(200).json({ message: "As a developer, your account has a large amount of control and permissions.\nTherefore, it is very important you secure your account.\nPlease enable Two-Factor Authentication at your next convenience.", userID: userID, username: username, accessToken: accessToken});
          else return res.status(200).json({ userID: userID, username: username, accessToken: accessToken});
     }

     if(typeof two_factor_code !== 'string') {
          if(typeof hwid !== 'string') return res.status(400).send({message: "You have 2FA enabled on your account but you did not specify a valid 2 Factor Authentication token.", failureCode: "1"});

          if(data.auth.multi_factor_authenticated_logins.length < 1) return res.status(400).send({message: "You have 2FA enabled on your account but you did not specify a valid 2 Factor Authentication token.", failureCode: "1"});

          const MatchingLogins = data.auth.multi_factor_authenticated_logins.filter(item => {
               // Return   IP match (include proxies)        HWID match    Less than 30 days since MFA login
               return item.ips == req.ips && item.hwid === hwid && Date.now() < item.timestamp + 2592000000;
          });


          if(MatchingLogins.length > 0) return res.status(200).json({ userID: userID, username: username, accessToken: accessToken});

          return res.status(400).send({message: "You have 2FA enabled on your account but you did not specify a valid 2 Factor Authentication token.", failureCode: "1"});
     }

     Verify2faCode(userID, two_factor_code, status => {
          switch(status) {
               case 'approved':
                    if(typeof hwid !== 'string') return res.status(200).json({ userID: userID, username: username, accessToken: accessToken});
                    const login = {
                         ips: req.ips,
                         hwid: hwid,
                         timestamp: Date.now()
                    }
                    data.auth.multi_factor_authenticated_logins.push(login);
                    helpers.PushPlayerData(userID, data);
                    return res.status(200).json({ userID: userID, username: username, accessToken: accessToken});
               case 'denied':
                    return res.status(401).send({message: "2FA Denied.", failureCode: "2"});
               case 'expired':
                    return res.status(401).send({message: "2FA Code Outdated", failureCode: "3"});
               case 'pending':
                    return res.status(400).send({message: "2FA Denied.", failureCode: "4"});
          }
     });
});

router.post("/refresh", middleware.authenticateToken, async (req, res) => {
     const data = helpers.PullPlayerData(req.user.id);

     for (let index = 0; index < data.auth.bans.length; index++) {
          const element = data.auth.bans[index];
          
          if(element.endTS > Date.now()) return res.status(403).send({
               message: "USER IS BANNED", 
               endTimeStamp: element.endTS, 
               reason: element.reason,
               failureCode: "7"
          });
     }

     const developer = data.private.availableTags.includes("Developer");

     const user = {username: data.public.username, id: req.user.id, developer: developer};

     const accessToken = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, { expiresIn: "30m" });
     return res.status(200).json({ userID: req.user.id, username: data.public.username, accessToken: accessToken});
});

//Call to create an account from a set of credentials.
router.post("/create", async (req, res) => {
     var { username, nickname, password } = req.body;
     const id = helpers.getAccountCount() + 1;

     if(username == null || password == null) return res.status(400).send("Username or password empty or null.")
     if(nickname == null) nickname = username;

     const check = helpers.getUserID(username);

     if(check != null) return res.status(400).send("Account already exists with that username. Please choose a different username.");

     const data = helpers.PullPlayerData("ACCT_TEMPLATE");

     BadWordList.forEach(element => {
          if(username.toLowerCase().includes(element)) return res.status(400).send("Your username contains profanity or foul language. Change it to continue.");
          if(nickname.toLowerCase().includes(element)) return res.status(400).send("Your nickname contains profanity or foul language. Change it to continue.");
     });

     data.public.nickname = nickname;
     data.public.username = username;

     data.auth.username = username;

     const salt = bcrypt.genSaltSync(10);

     const HASHED_PASSWORD = bcrypt.hashSync(password, salt);

     data.auth.HASHED_PASSWORD = HASHED_PASSWORD;
     data.auth.salt = salt;

     fs.writeFileSync(`./data/accounts/${id}.json`, JSON.stringify(data, null, "    "));
     res.sendStatus(200);

     const client = require('../index').mongoClient;
     const db = client.db(process.env.MONGOOSE_DATABASE_NAME);
     const collection = db.collection("servers");
     
     // this is stupid but i'm not fucking with brackets rn
     // i'm just trying to get this to work
     // please don't hate me
     // copilot wrote this comment
     var filter_idk = {};
     filter_idk.users = {};
     filter_idk.users[id] = {};

     console.log(await collection.findOneAndUpdate({_id: {$eq: "a8ec2c20-a4c7-11ec-896d-419328454766"}}, {$set: filter_idk}, {upsert: true}));
});

router.post("/check", middleware.authenticateToken, async (req, res) => {
     return res.sendStatus(200);
});

router.get("/mfa-enabled", middleware.authenticateToken, async (req, res) => {
     const data = helpers.PullPlayerData(req.user.id);
     return res.status(200).send(`${data.auth.mfa_enabled}`);
});

function Verify2faUser(user_id, code, callback) {
     user_id = sanitize(user_id);
     var data = helpers.PullPlayerData(user_id);
     client.verify.services(process.env.TWILIO_SERVICE_SID)
               .entities(`COMPENSATION-VR-ACCOUNT-ID-${user_id}`)
               .factors(data.auth.mfa_factor_sid)
               .update({authPayload: code})
               .then(factor => {
                    callback(factor.status == 'verified');
               });
}

function Verify2faCode(user_id, code, callback) {
     user_id = sanitize(user_id);
     var data = helpers.PullPlayerData(user_id);
     client.verify.services(process.env.TWILIO_SERVICE_SID)
               .entities(`COMPENSATION-VR-ACCOUNT-ID-${user_id}`)
               .challenges
               .create({authPayload: code, factorSid: data.auth.mfa_factor_sid})
               .then(challenge => {
                    callback(challenge.status);
                    // challenge.status == 'approved';
                    // challenge.status == 'denied';
                    // challenge.status == 'expired';
                    // challenge.status == 'pending';
               });
}

module.exports = router;