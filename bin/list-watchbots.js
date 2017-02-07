'use strict';
const AWS = require('aws-sdk');

const allRegions = process.env.MAPBOX_AVAILABLE_REGIONS.split(',');

getAllWatchbots(allRegions)
  .then(stacks => console.log(stacks))
  .catch(err => console.log(err));

// Ask for parameters - I'm thinking probably region? Or should we just list all regions?
// const cf = new Cloudformation(region);
// cf.describeStacks for each region?
// iterate through, grab metadata of watchbot tasks

function getAllWatchbots(allRegions) {
  const regionWatchbots = allRegions.map(region => {
    const cf = new AWS.CloudFormation({ region });

    return new Promise((resolve, reject) => {
      let regionStacks = [];

      cf.listStacks().eachPage((err, data, done) => {
        if (err) return reject(err);
        if (!data) {
          console.log(regionStacks);
          return resolve(Promise.all(regionStacks));
        }
        const stacks = data.StackSummaries.filter(stack => {
          return stack.StackStatus !== 'DELETE_COMPLETE';
        }).map(stack => {
          return cf.getTemplate({ StackName: stack.StackName }).promise()
            .then(data => {
              return {
                name: stack.StackName,
                template: JSON.parse(data.TemplateBody)
              };
            });
        });

        regionStacks.push(Promise.all(stacks)
          .then(stacks => {
            return stacks.filter(stack => {
              return stack.template.Metadata && stack.template.Metadata.EcsWatchbotVersion;
            }).map(stack => {
              return {
                stack: stack.name,
                watchbotVersion: stack.template.Metadata.EcsWatchbotVersion,
                region: region
              };
            });
          }));
      });
    });
  });

  console.log(regionWatchbots);

  return Promise.all(regionWatchbots);
}
