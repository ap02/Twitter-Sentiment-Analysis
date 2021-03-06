'use strict';
var PubNub = require('pubnub')
const request = require('request');
const Twitter = require('twitter');
const config = require('./local.json');
const client = new Twitter({
  consumer_key: config.twitter_consumer_key,
  consumer_secret: config.twitter_consumer_secret,
  access_token_key: config.twitter_access_key,
  access_token_secret: config.twitter_access_secret
});
var positive = 0;
var negative = 0;
var neutral = 0;
const gcloud = require('google-cloud')({
  keyFilename: 'keyfile.json',
  projectId: config.project_id
});
const bigquery = gcloud.bigquery();
const dataset = bigquery.dataset(config.bigquery_dataset);
const table = dataset.table(config.bigquery_table);

const Filter = require('bad-words'),
  filter = new Filter();

// Replace searchTerms with whatever tweets you want to stream
// Details here: https://dev.twitter.com/streaming/overview/request-parameters#track
const searchTerms = 'apple watch,apple music,iphone 8,iphone X,ios,iphone 7,macbook pro,apple TV,apple pay,imac,macOS High Sierra';

// Add a filter-level param?
client.stream('statuses/filter', {track: searchTerms, language: 'en'}, function(stream) {
  stream.on('data', function(event) {
                // Exclude tweets starting with "RT"
                if ((event.text != undefined) && (event.text.substring(0,2) != 'RT') && (event.text === filter.clean(event.text))) {
                        callNLApi(event);
                }
  });
  stream.on('error', function(error) {
    console.log('twitter api error: ', error);
  });
});


// INITIALIZE FIREBASE
var admin = require("firebase-admin");
var serviceAccount = require("./keyfile.json");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://" + config.project_id + ".firebaseio.com"
});

const db = admin.database();
const tweetRef = db.ref('latest');
const hashtagRef = db.ref('hashtags');

// Uses a Firebase transaction to incrememnt a counter
function incrementCount(ref, child, valToIncrement) {
  ref.child(child).transaction(function(data) {
    if (data != null) {
      data += valToIncrement;
    } else {
      data = 1;
    }
    return data;
  });
}


tweetRef.on('value', function (snap) {
    if (snap.exists()) {
      let tweet = snap.val();
      let tokens = tweet['tokens'];
      let hashtags = tweet['hashtags'];

      for (let i in tokens) {
        let token = tokens[i];
        let word = token.lemma.toLowerCase();

        if ((acceptedWordTypes.indexOf(token.partOfSpeech.tag) != -1) && !(word.match(/[^A-Za-z0-9]/g))) {
          let posRef = db.ref('tokens/' + token.partOfSpeech.tag);
          incrementCount(posRef, word, 1);
        }

      }

      if (hashtags) {
        for (let i in hashtags) {
          let ht = hashtags[i];
          let text = ht.text.toLowerCase();
          let htRef = hashtagRef.child(text);
          incrementCount(htRef, 'totalScore', tweet.score);
          incrementCount(htRef, 'numMentions', 1);
        }
      }
    }
});


const acceptedWordTypes = ['ADJ']; // Add the parts of speech you'd like to graph to this array ('NOUN', 'VERB', etc.)

function callNLApi(tweet) {
        const textUrl = "https://language.googleapis.com/v1/documents:annotateText?key=" + config.cloud_api_key;
        let requestBody = {
                "document": {
                        "type": "PLAIN_TEXT",
                        "content": tweet.text
                },
                "features": {
                  "extractSyntax": true,
                  "extractEntities": true,
                  "extractDocumentSentiment": true
                }
        }

        let options = {
                url: textUrl,
                method: "POST",
                body: requestBody,
                json: true
        }

        request(options, function(err, resp, body) {
                if ((!err && resp.statusCode == 200) && (body.sentences.length != 0)) {
                        let tweetForFb = {
                          id: tweet.id_str,
                          text: tweet.text,
                          user: tweet.user.screen_name,
                          user_time_zone: tweet.user.time_zone,
                          user_followers_count: tweet.user.followers_count,
                          hashtags: tweet.entities.hashtags,
                          tokens: body.tokens,
                          score: body.documentSentiment.score,
                          magnitude: body.documentSentiment.magnitude,
                          entities: body.entities
                        };

                        let bqRow = {
                          id: tweet.id_str,
                          text: tweet.text,
                          user: tweet.user.screen_name,
                          user_time_zone: tweet.user.time_zone,
                          user_followers_count: tweet.user.followers_count,
                          hashtags: JSON.stringify(tweet.entities.hashtags),
                          tokens: JSON.stringify(body.tokens),
                          score: body.documentSentiment.score,
                          magnitude: body.documentSentiment.magnitude,
                          entities: JSON.stringify(body.entities)
                        }
                        var pubnub = new PubNub({
                          publishKey:   '', // replace with your own pub-key
                          subscribeKey: '' // replace with your own sub-key
                        });



			 if (body.documentSentiment.magnitude*body.documentSentiment.score > 0) {
                         positive = positive + 1;
                          } else if (body.documentSentiment.magnitude*body.documentSentiment.score < 0){
			 negative = negative + 1;
                          } else {
                         neutral = neutral + 1;
                          }

                          pubnub.publish({
                            channel: 'lei_test_channel',
                            message: {
                              eon: {
                                'Positive':positive ,
                                'Neutral': neutral,
                                'Negative': negative,
                              }
                            }
                          });

                        tweetRef.set(tweetForFb);
                        table.insert(bqRow, function(error, insertErr, apiResp) {
                          if (error) {
                            console.log('err', error);
                          } else if (insertErr.length == 0) {
                            console.log('success!');
                          }
                        });

                } else {
                        console.log('NL API error: ', err);
                }
        });
}
