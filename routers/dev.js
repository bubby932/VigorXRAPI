const router = require('express').Router();
const helpers = require('../helpers');
const middleware = require('../middleware');
const BadWordList = JSON.parse(require('../data/external/badwords-master/array.json'));
const sanitize = require('sanitize-filename');

//Check if a token is valid as developer.
app.get("/dev/check", middleware.authenticateDeveloperToken, async (req, res) => {
     return res.status(200).send("This token is verified as Developer.");
});

module.exports = router;