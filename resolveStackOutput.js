const { CloudFormationClient, DescribeStacksCommand } = require('@aws-sdk/client-cloudformation');
const getAwsOptions = require('./getAwsOptions');

function resolveStackOutput(serverless, outputKey) {
  const provider = serverless.getProvider('aws');
  const options = getAwsOptions(serverless);
  const cfn = new CloudFormationClient(options);
  const stackName = provider.naming.getStackName();

  const command = new DescribeStacksCommand({ StackName: stackName });
  
  return cfn.send(command)
    .then(data => {
      const output = data.Stacks[0].Outputs.find(
        e => e.OutputKey === outputKey
      );
      if (!output) {
        throw `Failed to resolve stack Output '${outputKey}' in stack '${stackName}'`;
      }
      return output.OutputValue;
    });
}

module.exports = resolveStackOutput;
