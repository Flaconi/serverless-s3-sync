function getAwsOptions(serverless, credentials) {
  // For AWS SDK v3 compatibility with newer Serverless Framework versions
  const provider = serverless.getProvider('aws');
  
  // Get region - handle different Serverless Framework versions
  let region;
  if (typeof provider.getRegion === 'function') {
    // Older Serverless Framework versions
    region = provider.getRegion();
  } else {
    // Newer Serverless Framework versions
    region = serverless.service.provider.region || process.env.AWS_REGION || 'us-east-1';
  }

  // For AWS SDK v3, it's often better to let it handle credential resolution automatically
  // unless we have explicit, valid credentials
  const options = { region };

  // Only add credentials if we have explicitly provided ones that are valid
  if (credentials && 
      credentials.accessKeyId && 
      credentials.secretAccessKey) {
    options.credentials = {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
    };
    
    // Add session token if available
    if (credentials.sessionToken) {
      options.credentials.sessionToken = credentials.sessionToken;
    }
  } else if (provider.cachedCredentials && 
             provider.cachedCredentials.accessKeyId &&
             provider.cachedCredentials.secretAccessKey) {
    // Use cached credentials only if they're complete
    options.credentials = {
      accessKeyId: provider.cachedCredentials.accessKeyId,
      secretAccessKey: provider.cachedCredentials.secretAccessKey,
    };
    
    if (provider.cachedCredentials.sessionToken) {
      options.credentials.sessionToken = provider.cachedCredentials.sessionToken;
    }
  }
  // If no valid credentials found, let AWS SDK v3 handle credential resolution
  // It will check environment variables, profiles, IAM roles, etc.

  return options;
}

module.exports = getAwsOptions
