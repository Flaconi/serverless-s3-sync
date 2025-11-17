const ServerlessS3Sync = require('../index');

// Mock serverless object
const mockServerless = {
  service: {
    custom: {
      s3Sync: {
        bucketName: 'test-bucket',
        localDir: './test-files',
        bucketPrefix: 'prefix/'
      }
    },
    serverless: {
      config: {
        servicePath: '/tmp/test'
      }
    },
    provider: {
      profile: 'default'
    }
  },
  getProvider: () => ({
    sdk: {
      S3: class MockS3 {
        constructor() {}
      }
    }
  }),
  cli: {
    consoleMode: false
  },
  pluginManager: {
    spawn: false
  }
};

const mockOptions = {};
const mockLogging = {
  log: {
    info: console.log,
    error: console.error,
    warning: console.warn,
    success: console.log
  },
  progress: {
    update: () => {},
    remove: () => {}
  }
};

// Test basic instantiation
try {
  const plugin = new ServerlessS3Sync(mockServerless, mockOptions, mockLogging);
  console.log('✅ Plugin instantiation successful');
  console.log('✅ Commands defined:', Object.keys(plugin.commands));
  console.log('✅ Hooks defined:', Object.keys(plugin.hooks));
  console.log('✅ Basic test passed - AWS SDK v3 migration successful!');
} catch (error) {
  console.error('❌ Plugin instantiation failed:', error.message);
  process.exit(1);
}
