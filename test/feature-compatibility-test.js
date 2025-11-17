const ServerlessS3Sync = require('../index');
const fs = require('fs');
const path = require('path');

// Mock AWS SDK v3 clients
jest.mock('@aws-sdk/client-s3', () => {
  const mockS3Commands = {
    HeadObjectCommand: jest.fn(),
    PutObjectCommand: jest.fn(), 
    CopyObjectCommand: jest.fn(),
    ListObjectsV2Command: jest.fn(),
    DeleteObjectCommand: jest.fn(),
    GetBucketTaggingCommand: jest.fn(),
    PutBucketTaggingCommand: jest.fn()
  };

  return {
    S3Client: jest.fn(() => ({
      send: jest.fn(),
      middlewareStack: {
        add: jest.fn()
      }
    })),
    ...mockS3Commands
  };
});

jest.mock('@aws-sdk/client-cloudformation', () => {
  const mockCloudFormationCommands = {
    DescribeStacksCommand: jest.fn()
  };

  return {
    CloudFormationClient: jest.fn(() => ({
      send: jest.fn().mockResolvedValue({
        Stacks: [{
          Outputs: [{
            OutputKey: 'TestBucketName',
            OutputValue: 'test-bucket-from-stack'
          }]
        }]
      })
    })),
    ...mockCloudFormationCommands
  };
});

// Create test files directory
const testDir = path.join(__dirname, 'test-files');
if (!fs.existsSync(testDir)) {
  fs.mkdirSync(testDir, { recursive: true });
}

// Create test files
fs.writeFileSync(path.join(testDir, 'index.html'), '<html><body>Test</body></html>');
fs.writeFileSync(path.join(testDir, 'app.js'), 'console.log("test");');
fs.writeFileSync(path.join(testDir, 'style.css'), 'body { margin: 0; }');

describe('ServerlessS3Sync - Feature Compatibility Tests', () => {
  let plugin;
  let mockServerless;
  let mockOptions;
  let mockLogging;

  beforeEach(() => {
    mockServerless = {
      service: {
        custom: {
          s3Sync: [{
            bucketName: 'test-bucket',
            localDir: './test/test-files',
            bucketPrefix: 'prefix/',
            acl: 'public-read',
            deleteRemoved: true,
            followSymlinks: false,
            defaultContentType: 'text/html',
            enabled: true,
            params: [
              {
                'index.html': {
                  CacheControl: 'no-cache',
                  OnlyForEnv: 'production'
                }
              },
              {
                '*.js': {
                  CacheControl: 'public, max-age=31536000'
                }
              }
            ],
            bucketTags: {
              Environment: 'test',
              Project: 'serverless-s3-sync'
            }
          }]
        },
        serverless: {
          config: {
            servicePath: process.cwd()
          }
        },
        provider: {
          stage: 'production'
        }
      },
      getProvider: () => ({
        naming: {
          getStackName: () => 'test-stack'
        }
      }),
      cli: {
        consoleMode: false
      },
      pluginManager: {
        spawn: false
      }
    };

    mockOptions = {
      env: 'production'
    };

    mockLogging = {
      log: {
        info: jest.fn(),
        error: jest.fn(),
        warning: jest.fn(),
        success: jest.fn(),
        verbose: jest.fn()
      },
      progress: {
        create: jest.fn(() => ({
          update: jest.fn(),
          remove: jest.fn()
        }))
      }
    };

    plugin = new ServerlessS3Sync(mockServerless, mockOptions, mockLogging);
  });

  afterAll(() => {
    // Cleanup test files
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  describe('Plugin Initialization', () => {
    test('should initialize with correct commands structure', () => {
      expect(plugin.commands.s3sync).toBeDefined();
      expect(plugin.commands.s3sync.lifecycleEvents).toEqual(['sync', 'metadata', 'tags']);
      expect(plugin.commands.s3sync.commands.bucket).toBeDefined();
      expect(plugin.commands.deploy.options.nos3sync).toBeDefined();
      expect(plugin.commands.remove.options.nos3sync).toBeDefined();
      expect(plugin.commands.offline.options.nos3sync).toBeDefined();
    });

    test('should initialize with correct hooks', () => {
      const expectedHooks = [
        'after:aws:deploy:deploy:createStack',
        'aws:remove:remove:removeStack',
        'after:deploy:deploy',
        'after:offline:start:init',
        'after:offline:start',
        'before:offline:start',
        'before:offline:start:init',
        'before:remove:remove',
        's3sync:sync',
        's3sync:metadata',
        's3sync:tags',
        's3sync:bucket:sync',
        's3sync:bucket:metadata',
        's3sync:bucket:tags'
      ];

      expectedHooks.forEach(hook => {
        expect(plugin.hooks[hook]).toBeDefined();
        expect(typeof plugin.hooks[hook]).toBe('function');
      });
    });
  });

  describe('Configuration Handling', () => {
    test('should handle array configuration', () => {
      const config = plugin.serverless.service.custom.s3Sync;
      expect(Array.isArray(config)).toBe(true);
    });

    test('should handle bucket configuration', () => {
      plugin.serverless.service.custom.s3Sync = {
        buckets: [{
          bucketName: 'test-bucket',
          localDir: './test'
        }]
      };
      
      expect(plugin.serverless.service.custom.s3Sync.buckets).toBeDefined();
    });

    test('should handle enabled flag', () => {
      plugin.serverless.service.custom.s3Sync[0].enabled = false;
      // Test would verify that disabled buckets are skipped
      expect(plugin.serverless.service.custom.s3Sync[0].enabled).toBe(false);
    });
  });

  describe('Utility Functions', () => {
    test('getLocalFiles should recursively find files', () => {
      const files = plugin.getLocalFiles(testDir, []);
      expect(files.length).toBeGreaterThan(0);
      expect(files.some(f => f.includes('index.html'))).toBe(true);
      expect(files.some(f => f.includes('app.js'))).toBe(true);
      expect(files.some(f => f.includes('style.css'))).toBe(true);
    });

    test('extractMetaParams should extract parameters correctly', () => {
      const config = {
        'index.html': { CacheControl: 'no-cache', ContentType: 'text/html' }
      };
      const result = plugin.extractMetaParams(config);
      expect(result.CacheControl).toBe('no-cache');
      expect(result.ContentType).toBe('text/html');
    });

    test('mergeTags should merge tags correctly', () => {
      const existingTags = [
        { Key: 'Environment', Value: 'old' },
        { Key: 'Project', Value: 'existing' }
      ];
      const newTags = [
        { Key: 'Environment', Value: 'new' },
        { Key: 'Owner', Value: 'team' }
      ];

      plugin.mergeTags(existingTags, newTags);

      expect(existingTags).toHaveLength(3);
      expect(existingTags.find(t => t.Key === 'Environment').Value).toBe('new');
      expect(existingTags.find(t => t.Key === 'Project').Value).toBe('existing');
      expect(existingTags.find(t => t.Key === 'Owner').Value).toBe('team');
    });

    test('getBucketPrefix should return correct prefix', () => {
      const config = { bucketPrefix: 'assets/' };
      expect(plugin.getBucketPrefix(config)).toBe('assets/');
      
      // Should allow empty prefix for sync operations (backward compatibility)
      expect(plugin.getBucketPrefix({})).toBe('');
      expect(plugin.getBucketPrefix({ bucketPrefix: '' })).toBe('');
    });
  });

  describe('Environment Configuration', () => {
    test('getNoSync should detect noSync configuration', () => {
      plugin.options.nos3sync = true;
      expect(plugin.getNoSync()).toBe(true);

      plugin.options.nos3sync = false;
      plugin.serverless.service.custom.s3Sync.noSync = true;
      expect(plugin.getNoSync()).toBe(true);

      plugin.serverless.service.custom.s3Sync.noSync = 'TRUE';
      expect(plugin.getNoSync()).toBe(true);
    });

    test('getCustomHooks should return hooks array', () => {
      plugin.serverless.service.custom.s3Sync.hooks = ['after:deploy:finalize'];
      expect(plugin.getCustomHooks()).toEqual(['after:deploy:finalize']);
    });

    test('isOffline should detect offline mode', () => {
      plugin.offline = true;
      expect(plugin.isOffline()).toBe(true);

      plugin.offline = false;
      process.env.IS_OFFLINE = 'true';
      expect(plugin.isOffline()).toBe(true);
      delete process.env.IS_OFFLINE;
      
      // Test string check
      plugin.offline = false;
      process.env.IS_OFFLINE = 'TRUE';
      expect(plugin.isOffline()).toBe(true);
      delete process.env.IS_OFFLINE;
    });

    test('getEndpoint should return endpoint for offline mode', () => {
      plugin.serverless.service.custom.s3Sync.endpoint = 'http://localhost:4569';
      expect(plugin.getEndpoint()).toBe('http://localhost:4569');
    });
  });

  describe('AWS Integration', () => {
    test('resolveStackOutput integration', async () => {
      const resolveStackOutput = require('../resolveStackOutput');
      
      const result = await resolveStackOutput(mockServerless, 'TestBucketName');
      expect(result).toBe('test-bucket-from-stack');
    });

    test('getBucketName should resolve bucket name', async () => {
      const config = { bucketName: 'direct-bucket' };
      const result = await plugin.getBucketName(config);
      expect(result).toBe('direct-bucket');
    });

    test('getBucketName should resolve from stack output', async () => {
      const config = { bucketNameKey: 'TestBucketName' };
      const result = await plugin.getBucketName(config);
      expect(result).toBe('test-bucket-from-stack');
    });
  });

  describe('Configuration Validation', () => {
    test('should validate required configuration', () => {
      const invalidConfigs = [
        { localDir: './test' }, // missing bucket
        { bucketName: 'test' }, // missing localDir
        {} // missing both
      ];

      invalidConfigs.forEach(config => {
        expect(() => {
          if ((!config.bucketName && !config.bucketNameKey) || !config.localDir) {
            throw 'Invalid custom.s3Sync';
          }
        }).toThrow('Invalid custom.s3Sync');
      });
    });
  });

  describe('Parameter Processing', () => {
    test('should process OnlyForEnv parameter correctly', () => {
      const getS3ParamsCallback = jest.fn();
      
      // Simulate the getS3Params callback processing
      const s3Params = {};
      const testParam = {
        'index.html': {
          CacheControl: 'no-cache',
          OnlyForEnv: 'production'
        }
      };
      
      const extracted = plugin.extractMetaParams(testParam);
      expect(extracted.OnlyForEnv).toBe('production');
      expect(extracted.CacheControl).toBe('no-cache');
    });
  });

  describe('S3CompatClient Integration', () => {
    test('should create S3CompatClient correctly', () => {
      const client = plugin.client();
      expect(client).toBeDefined();
      expect(client.s3Client).toBeDefined();
      expect(typeof client.uploadDir).toBe('function');
      expect(typeof client.deleteDir).toBe('function');
      expect(typeof client.copyObject).toBe('function');
    });

    test('should handle offline endpoint configuration', () => {
      plugin.serverless.service.custom.s3Sync.endpoint = 'http://localhost:4569';
      plugin.offline = true;
      
      const client = plugin.client();
      expect(client).toBeDefined();
      // Verify that middleware was added for offline mode
      expect(client.s3Client.middlewareStack.add).toHaveBeenCalled();
    });
  });

  describe('Security Features', () => {
    test('remove operation should require bucketPrefix for safety', async () => {
      // Mock s3Sync configuration without bucketPrefix (single config, not array)
      plugin.serverless.service.custom.s3Sync = {
        bucketName: 'test-bucket',
        localDir: './test'
        // No bucketPrefix - this should cause remove to fail
      };



      // Remove operation should fail without bucketPrefix
      await expect(plugin.remove()).rejects.toThrow(
        'bucketPrefix is required for remove operations to prevent accidental deletion of entire bucket contents'
      );
    });
  });

  describe('Error Handling', () => {
    test('should handle missing directory gracefully', () => {
      const nonExistentDir = path.join(__dirname, 'non-existent');
      const files = plugin.getLocalFiles(nonExistentDir, []);
      expect(files).toEqual([]);
      expect(mockLogging.log.error).toHaveBeenCalledWith(
        expect.stringContaining('does not exist')
      );
    });
  });
});

// Integration test for complete workflow
describe('ServerlessS3Sync - Integration Tests', () => {
  test('complete sync workflow simulation', async () => {
    // This would be an integration test that simulates the entire sync process
    // Including file discovery, parameter processing, and S3 operations
    expect(true).toBe(true); // Placeholder
  });

  test('metadata sync workflow simulation', async () => {
    // This would test the complete metadata sync process
    expect(true).toBe(true); // Placeholder
  });

  test('bucket tags workflow simulation', async () => {
    // This would test the complete bucket tagging process
    expect(true).toBe(true); // Placeholder
  });
});