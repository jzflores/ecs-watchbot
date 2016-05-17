var url = require('url');
var util = require('util');
var AWS = require('aws-sdk');
var d3 = require('d3-queue');
var notifications = require('./notifications');

/**
 * Creates messages objects
 *
 * @static
 * @memberof watchbot
 * @name messages
 * @param {string} queue - the URL of an SQS queue
 * @param {string} topic - the ARN of an SNS topic for failure notifications
 * @param {string} stackName - the name of the CloudFormation stack
 * @param {boolean} backoff - whether jobs retrying should be returned to SQS
 * with exponential backoff.
 * @returns {object} a {@link messages} object
 */
module.exports = function(queue, topic, stackName, backoff) {
  var sqs = new AWS.SQS({
    region: url.parse(queue).host.split('.')[1],
    params: { QueueUrl: queue }
  });

  var sendNotification = notifications(topic).send;
  var messagesInFlight = {};

  /**
   * An SQS message tracker
   */
  var messages = {};

  /**
   * Poll SQS to find jobs
   *
   * @param {number} max - the maximum number of jobs to take from the queue (max 10)
   * @param {function} callback - a function called after polling completes. The
   * callback will be provided with an object of key-value object pairs representing
   * environment variables (see {@link environment}) to be provided to a task
   */
  messages.poll = function(max, callback) {
    sqs.receiveMessage({
      AttributeNames: [
        'SentTimestamp',
        'ApproximateFirstReceiveTimestamp',
        'ApproximateReceiveCount'
      ],
      WaitTimeSeconds: 20,
      MaxNumberOfMessages: Math.min(max, 10)
    }, function(err, data) {
      if (err) return callback(err);

      if (!data.Messages || !data.Messages.length)
        return callback(null, []);

      var envs = data.Messages.filter(function(message) {
        var notInFlight = !messagesInFlight[message.MessageId];
        messagesInFlight[message.MessageId] = message.ReceiptHandle;
        return notInFlight;
      }).map(function(message) {
        var snsMessage = JSON.parse(message.Body);

        /**
         * Environment variables providing SQS message details to the processing task
         *
         * @name environment
         * @property {string} MessageId - the SQS MessageId
         * @property {string} Subject - the message's subject
         * @property {string} Message - the message's body
         * @property {string} SentTimestamp - the time the message was sent
         * @property {string} ApproximateFirstReceiveTimestamp - the time the
         * message was first received
         * @property {string} ApproximateReceiveCount - the number of times the
         * message has been received
         */
        return {
          MessageId: message.MessageId,
          Subject: snsMessage.Subject,
          Message: snsMessage.Message,
          SentTimestamp: message.Attributes.SentTimestamp.toString(),
          ApproximateFirstReceiveTimestamp: message.Attributes.ApproximateFirstReceiveTimestamp.toString(),
          ApproximateReceiveCount: message.Attributes.ApproximateReceiveCount.toString()
        };
      });

      callback(null, envs);
    });
  };

  /**
   * Handle a completed SQS message
   *
   * @param {object} finishedTask - a {@link fainishedTask} object defining the task outcome
   * @param {function} callback - a function called when the finished job has been
   * handled appropriately
   */
  messages.complete = function(finishedTask, callback) {
    var queue = d3.queue(2);

    var messageId = finishedTask.env.MessageId;
    var receives = Number(finishedTask.env.ApproximateReceiveCount);
    var handle = messagesInFlight[messageId];

    if (!handle) return allDone();

    function messageMissing(err) {
      return /Message does not exist or is not available for visibility timeout change/.test(err.message);
    }

    finishedTask.outcome.split(' & ').forEach(function(toDo) {
      if (toDo === 'delete') {
        queue.defer(function(next) {
          sqs.deleteMessage({ ReceiptHandle: handle }, function(err) {
            if (err && messageMissing(err)) return next();
            next(err);
          });
        });
      }

      if (toDo === 'return') {
        queue.defer(function(next) {
          if (backoff && receives > 14) return next();
          var timeout = backoff ? Math.pow(2, receives) : 0;

          sqs.changeMessageVisibility({
            ReceiptHandle: handle,
            VisibilityTimeout: timeout
          }, function(err) {
            if (err && messageMissing(err)) return next();
            next(err);
          });
        });
      }

      if (toDo === 'notify') {
        queue.defer(
          sendNotification,
          '[watchbot] failed job',
          util.format('At %s, job %s failed on %s', (new Date()).toUTCString(), messageId, stackName)
        );
      }
    });

    function allDone(err) {
      delete messagesInFlight[messageId];
      callback(err);
    }

    queue.awaitAll(allDone);
  };

  return messages;
};