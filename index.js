'use strict';

// Test OIDC prerelease publishing - Nov 7, 2025
const BbPromise = require('bluebird');
const { S3Client, PutObjectCommand, GetBucketTaggingCommand, PutBucketTaggingCommand, ListObjectsV2Command, DeleteObjectCommand, HeadObjectCommand, CopyObjectCommand } = require('@aws-sdk/client-s3');
const minimatch = require('minimatch');
const path = require('path');
const fs = require('fs');
const resolveStackOutput = require('./resolveStackOutput');
const getAwsOptions = require('./getAwsOptions');
const mime = require('mime');
const child_process = require('child_process');

const toS3Path = (osPath) => osPath.replace(new RegExp(`\\${path.sep}`, 'g'), '/');

/*
  From @auth0/s3/lib/index.js - used when uploading the file in the first place
  - added the + character to the set that are escaped.
  Using is is needed to update the meta data of keys that contain spaces, +, etc...
  to avoid a Key not found exception.
*/
function encodeSpecialCharacters(filename) {
  // Note: these characters are valid in URIs, but S3 does not like them for
  // some reason.
  return encodeURI(filename).replace(/[+!'()* ]/g, function (char) {
    return '%' + char.charCodeAt(0).toString(16);
  });
}

/**
 * AWS SDK v3 client that mimics the @auth0/s3 interface
 * This maintains exact compatibility with the original library behavior
 */
class S3CompatClient {
  constructor(s3Client) {
    this.s3Client = s3Client;
  }

  uploadDir(options) {
    return new S3UploadDir(this.s3Client, options);
  }

  deleteDir(options) {
    return new S3DeleteDir(this.s3Client, options);
  }

  copyObject(options) {
    return new S3CopyObject(this.s3Client, options);
  }
}

/**
 * Mimics @auth0/s3 uploadDir behavior exactly
 */
class S3UploadDir {
  constructor(s3Client, options) {
    this.s3Client = s3Client;
    this.options = options;
    this.progressAmount = 0;
    this.progressTotal = 0;
    this.eventCallbacks = {};
  }

  on(event, callback) {
    this.eventCallbacks[event] = callback;
    return this;
  }

  emit(event, data) {
    if (this.eventCallbacks[event]) {
      this.eventCallbacks[event](data);
    }
  }

  async start() {
    const { localDir, deleteRemoved, s3Params, getS3Params, followSymlinks, maxAsyncS3 } = this.options;
    const { Bucket, Prefix = '', ACL } = s3Params;

    try {
      // Get local files - exact same logic as original
      const localFiles = this.getAllFiles(localDir, followSymlinks);
      this.progressTotal = localFiles.length;
      this.progressAmount = 0;

      // Get existing S3 objects if deleteRemoved is true
      let existingKeys = new Set();
      if (deleteRemoved) {
        existingKeys = await this.getS3Objects(Bucket, Prefix);
      }

      // Upload files with same concurrency as original
      const uploadPromises = [];
      for (const filePath of localFiles) {
        const relativePath = path.relative(localDir, filePath);
        const s3Key = Prefix + toS3Path(relativePath);

        // Remove from deletion list
        if (deleteRemoved) {
          existingKeys.delete(s3Key);
        }

        const uploadPromise = this.uploadFile(filePath, Bucket, s3Key, ACL, getS3Params)
          .then(() => {
            this.progressAmount++;
            this.emit('progress');
          });

        uploadPromises.push(uploadPromise);

        // Respect maxAsyncS3 concurrency limit like original
        if (uploadPromises.length >= (maxAsyncS3 || 5)) {
          await Promise.all(uploadPromises);
          uploadPromises.length = 0;
        }
      }

      // Wait for remaining uploads
      if (uploadPromises.length > 0) {
        await Promise.all(uploadPromises);
      }

      // Delete removed files - exact same behavior as original
      if (deleteRemoved && existingKeys.size > 0) {
        await this.deleteS3Objects(Bucket, Array.from(existingKeys));
      }

      this.emit('end');
    } catch (error) {
      this.emit('error', error);
    }

    return this;
  }

  async uploadFile(filePath, bucket, key, acl, getS3Params) {
    // Check if file needs uploading (incremental sync like original)
    const needsUpload = await this.shouldUploadFile(filePath, bucket, key);
    if (!needsUpload) {
      return; // Skip upload if file unchanged
    }
    const fileContent = fs.readFileSync(filePath);
    const contentType = mime.getType(filePath) || 'application/octet-stream';

    const uploadParams = {
      Bucket: bucket,
      Key: key,
      Body: fileContent,
      ContentType: contentType,
      ...(acl && { ACL: acl })
    };

    // Apply custom S3 parameters exactly like original
    if (getS3Params && typeof getS3Params === 'function') {
      const stat = fs.statSync(filePath);
      getS3Params(filePath, stat, (err, customParams) => {
        if (!err && customParams) {
          Object.assign(uploadParams, customParams);
        }
      });
    }

    const command = new PutObjectCommand(uploadParams);
    await this.s3Client.send(command);
  }

  async shouldUploadFile(filePath, bucket, key) {
    try {
      // Get local file stats
      const localStat = fs.statSync(filePath);
      
      // Check if S3 object exists and get its metadata
      const headCommand = new HeadObjectCommand({
        Bucket: bucket,
        Key: key
      });
      
      const s3Object = await this.s3Client.send(headCommand);
      
      // If sizes are different, definitely upload
      if (localStat.size !== s3Object.ContentLength) {
        return true;
      }
      
      // For same size files, compare MD5 hash (like original @auth0/s3 library)
      const localMd5 = await this.calculateMD5(filePath);
      
      // S3 ETag is the MD5 hash for simple uploads (not multipart)
      // Remove quotes from ETag if present
      const s3Md5 = s3Object.ETag.replace(/"/g, '');
      
      if (localMd5 !== s3Md5) {
        return true;
      } else {
        return false;
      }
      
    } catch (error) {
      if (error.name === 'NotFound' || error.name === 'NoSuchKey') {
        return true;
      }
      
      // Upload to be safe if we can't check S3 status
      return true;
    }
  }

  async calculateMD5(filePath) {
    const crypto = require('crypto');
    const hash = crypto.createHash('md5');
    const stream = fs.createReadStream(filePath);
    
    return new Promise((resolve, reject) => {
      stream.on('data', data => hash.update(data));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  getAllFiles(dirPath, followSymlinks = false, arrayOfFiles = []) {
    const files = fs.readdirSync(dirPath);

    files.forEach((file) => {
      const fullPath = path.join(dirPath, file);
      const stat = fs.lstatSync(fullPath);
      
      if (stat.isDirectory()) {
        arrayOfFiles = this.getAllFiles(fullPath, followSymlinks, arrayOfFiles);
      } else if (stat.isFile() || (followSymlinks && stat.isSymbolicLink())) {
        arrayOfFiles.push(fullPath);
      }
    });

    return arrayOfFiles;
  }

  async getS3Objects(bucket, prefix) {
    const keys = new Set();
    let continuationToken;

    do {
      const command = new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken
      });

      const response = await this.s3Client.send(command);
      
      if (response.Contents) {
        response.Contents.forEach(obj => {
          keys.add(obj.Key);
        });
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return keys;
  }

  async deleteS3Objects(bucket, keys) {
    // Delete objects one by one like original
    for (const key of keys) {
      try {
        const command = new DeleteObjectCommand({
          Bucket: bucket,
          Key: key
        });
        await this.s3Client.send(command);
      } catch (error) {
        // Silently continue like original - don't break the process
        console.warn(`Warning: Failed to delete ${key}: ${error.message}`);
      }
    }
  }
}

/**
 * Mimics @auth0/s3 deleteDir behavior
 */
class S3DeleteDir {
  constructor(s3Client, options) {
    this.s3Client = s3Client;
    this.options = options;
    this.eventCallbacks = {};
  }

  on(event, callback) {
    this.eventCallbacks[event] = callback;
    return this;
  }

  emit(event, data) {
    if (this.eventCallbacks[event]) {
      this.eventCallbacks[event](data);
    }
  }

  async start() {
    const { s3Params } = this.options;
    const { Bucket, Prefix } = s3Params;

    try {
      const uploader = new S3UploadDir(this.s3Client, { deleteRemoved: true, s3Params });
      const keys = await uploader.getS3Objects(Bucket, Prefix);
      
      if (keys.size > 0) {
        await uploader.deleteS3Objects(Bucket, Array.from(keys));
      }

      this.emit('end');
    } catch (error) {
      this.emit('error', error);
    }

    return this;
  }
}

/**
 * Mimics @auth0/s3 copyObject behavior
 */
class S3CopyObject {
  constructor(s3Client, options) {
    this.s3Client = s3Client;
    this.options = options;
    this.eventCallbacks = {};
  }

  on(event, callback) {
    this.eventCallbacks[event] = callback;
    return this;
  }

  emit(event, data) {
    if (this.eventCallbacks[event]) {
      this.eventCallbacks[event](data);
    }
  }

  async start() {
    const { ACL, Bucket, CopySource, Key, MetadataDirective, Metadata } = this.options;

    try {
      const command = new CopyObjectCommand({
        ACL,
        Bucket,
        CopySource,
        Key,
        MetadataDirective,
        Metadata
      });

      await this.s3Client.send(command);
      this.emit('end');
    } catch (error) {
      this.emit('error', error);
    }

    return this;
  }
}

class ServerlessS3Sync {
  constructor(serverless, options, logging) {
    this.serverless = serverless;
    this.options = options || {};
    this.log = logging.log;
    this.progress = logging.progress;
    this.servicePath = this.serverless.service.serverless.config.servicePath;
    this.offline = String(this.options.offline).toUpperCase() === 'TRUE';

    this.commands = {
      s3sync: {
        usage: 'Sync directories and S3 prefixes',
        lifecycleEvents: [
          'sync',
          'metadata',
          'tags'
        ],
        commands: {
          bucket: {
            options: {
              bucket: {
                usage: 'Specify the bucket you want to deploy (e.g. "-b myBucket1")',
                required: true,
                shortcut: 'b'
              }
            },
            lifecycleEvents: [
              'sync',
              'metadata',
              'tags'
            ]
          }
        }
      },
      deploy: {
        options: {
          nos3sync: {
            type: 'boolean',
            usage: 'Disable sync to S3 during deploy'
          }
        }
      },
      remove: {
        options: {
          nos3sync: {
            type: 'boolean',
            usage: 'Disable sync to S3 during remove'
          }
        }
      },
      offline: {
        options: {
          nos3sync: {
            type: 'boolean',
            usage: 'Disable sync to S3 for serverless offline'
          }
        },
        commands: {
          start: {
            options: {
              nos3sync: {
                type: 'boolean',
                usage: 'Disable sync to S3 for serverless offline start command'
              }
            }
          }
        }
      }
    };

    // Check noSync configuration
    const noSync = this.getNoSync();
    
    // Get custom hooks from configuration
    const customHooks = this.getCustomHooks().reduce((acc, hook) => {
      acc[hook] = () => noSync ? undefined : BbPromise.bind(this).then(this.sync).then(this.syncMetadata).then(this.syncBucketTags);
      return acc;
    }, {});

    // Restore original hook structure exactly
    this.hooks = {
      'after:aws:deploy:deploy:createStack': () => noSync ? undefined : BbPromise.bind(this).then(this.sync).then(this.syncMetadata).then(this.syncBucketTags),
      'aws:remove:remove:removeStack': () => noSync ? undefined : BbPromise.bind(this).then(this.remove),
      'after:deploy:deploy': () => noSync ? undefined : BbPromise.bind(this).then(this.sync).then(this.syncMetadata).then(this.syncBucketTags),
      'after:offline:start:init': () => noSync ? undefined : BbPromise.bind(this).then(this.sync).then(this.syncMetadata).then(this.syncBucketTags),
      'after:offline:start': () => noSync ? undefined : BbPromise.bind(this).then(this.sync).then(this.syncMetadata).then(this.syncBucketTags),
      'before:offline:start': this.setOffline.bind(this),
      'before:offline:start:init': this.setOffline.bind(this),
      'before:remove:remove': () => noSync ? undefined : BbPromise.bind(this).then(this.remove),
      's3sync:sync': () => BbPromise.bind(this).then(() => this.sync(true)),
      's3sync:metadata': () => BbPromise.bind(this).then(() => this.syncMetadata(true)),
      's3sync:tags': () => BbPromise.bind(this).then(() => this.syncBucketTags(true)),
      's3sync:bucket:sync': () => BbPromise.bind(this).then(() => this.sync(true)),
      's3sync:bucket:metadata': () => BbPromise.bind(this).then(() => this.syncMetadata(true)),
      's3sync:bucket:tags': () => BbPromise.bind(this).then(() => this.syncBucketTags(true)),
      ...customHooks
    };

    const cli = this.serverless.cli;
    if (!this.serverless.pluginManager.spawn && cli && cli.consoleMode) {
      this.hooks['before:remove:remove'] = () => noSync ? undefined : BbPromise.bind(this).then(this.remove);
      this.hooks['after:deploy:deploy'] = () => noSync ? undefined : BbPromise.bind(this).then(this.sync).then(this.syncMetadata).then(this.syncBucketTags);
    }

    if (this.options.offline) {
      this.hooks['before:offline:start'] = () => noSync ? undefined : BbPromise.bind(this).then(this.sync).then(this.syncMetadata).then(this.syncBucketTags);
      this.hooks['before:offline:start:init'] = () => noSync ? undefined : BbPromise.bind(this).then(this.sync).then(this.syncMetadata).then(this.syncBucketTags);
    }

    let configured = this.serverless.service.custom && this.serverless.service.custom.s3Sync;

    if (configured) {
      configured = Object.assign(configured, options);
      const hooks = configured.hooks || [];
      hooks.forEach(hook => {
        this.hooks[hook] = () => noSync ? undefined : BbPromise.bind(this).then(this.sync).then(this.syncMetadata).then(this.syncBucketTags);
      });
    }
  }

  setOffline() {
    this.offline = true;
  }

  isOffline() {
    return this.offline || !!process.env.IS_OFFLINE;
  }

  getEndpoint() {
    const config = this.serverless.service.custom;
    if (config && config.s3Sync) {
      return config.s3Sync.endpoint;
    }
    return null;
  }

  getNoSync() {
    if (this.options.nos3sync) {
      return true;
    }
    if (this.serverless.service.custom && this.serverless.service.custom.s3Sync) {
      const noSync = this.serverless.service.custom.s3Sync.noSync;
      return String(noSync).toUpperCase() === 'TRUE';
    }
    return false;
  }

  getCustomHooks() {
    if (this.serverless.service.custom && this.serverless.service.custom.s3Sync) {
      return this.serverless.service.custom.s3Sync.hooks || [];
    }
    return [];
  }

  client() {
    const s3Options = getAwsOptions(this.serverless);
    
    if (this.getEndpoint() && this.isOffline()) {
      s3Options.endpoint = this.getEndpoint();
      s3Options.s3ForcePathStyle = true;
    }

    const s3Client = new S3Client(s3Options);
    
    // For offline mode compatibility
    if (this.getEndpoint() && this.isOffline()) {
      // Equivalent to shouldDisableBodySigning for AWS SDK v3
      s3Client.middlewareStack.add(
        (next) => async (args) => {
          if (args.request.headers) {
            delete args.request.headers['x-amz-content-sha256'];
          }
          return next(args);
        },
        {
          step: 'build',
          name: 'disableBodySigning'
        }
      );
    }
    
    return new S3CompatClient(s3Client);
  }

  getCredentials() {
    // For AWS SDK v3, return undefined to let it handle credential resolution
    // This allows it to use environment variables, profiles, IAM roles, etc.
    return undefined;
  }

  // Restore original sync method structure
  sync(invokedAsCommand) {
    // Check if configuration exists
    if (!this.serverless.service.custom || !this.serverless.service.custom.s3Sync) {
      return Promise.resolve();
    }

    let s3Sync = this.serverless.service.custom.s3Sync;
    
    if(s3Sync.hasOwnProperty('buckets')) {
      s3Sync = s3Sync.buckets;
    } else if (!Array.isArray(s3Sync)) {
      s3Sync = [s3Sync];
    }

    if (s3Sync.noSync && s3Sync.noSync === true) {
      this.log.info('Skipping sync due to noSync setting');
      return Promise.resolve();
    }

    const servicePath = this.servicePath;
    const promises = s3Sync.map((s, index) => {
      // Handle enabled flag
      if (s.hasOwnProperty('enabled') && s.enabled === false) {
        return Promise.resolve('skipped');
      }
      
      let followSymlinks = false;
      if (s.hasOwnProperty('followSymlinks')) {
        followSymlinks = s.followSymlinks;
      }
      let acl = 'private';
      if (s.hasOwnProperty('acl')) {
        acl = s.acl;
      }
      let defaultContentType = undefined;
      if (s.hasOwnProperty('defaultContentType')) {
        defaultContentType = s.defaultContentType;
      }
      let deleteRemoved = true;
      if (s.hasOwnProperty('deleteRemoved')) {
        deleteRemoved = s.deleteRemoved;
      }
      let preCommand = undefined;
      if (s.hasOwnProperty('preCommand')) {
        preCommand = s.preCommand;
      }

      if ((!s.bucketName && !s.bucketNameKey) || !s.localDir) {
        this.log.error(`❌ S3Sync validation failed for entry ${index}:`);
        
        if (!s.bucketName && !s.bucketNameKey) {
          this.log.error(`  Missing bucket: bucketName or bucketNameKey required`);
        }
        
        if (!s.localDir) {
          this.log.error(`  Missing localDir: ${s.localDir || 'undefined'}`);
        }
        
        throw 'Invalid custom.s3Sync - check configuration';
      }

      return this.getBucketName(s)
        .then(bucketName => {
          if (this.options.bucket && bucketName != this.options.bucket) {
            return null;
          }
          return new Promise((resolve) => {
            const localDir = [servicePath, s.localDir].join('/');

            let percent = 0;
            const getProgressMessage = () => `${localDir}: sync with bucket ${bucketName} (${percent}%)`;
            const bucketProgress = this.progress.create({ message: getProgressMessage() })

            if (typeof(preCommand) != 'undefined') {
              bucketProgress.update(`${localDir}: running pre-command...`);
              child_process.execSync(preCommand, { stdio: 'inherit' });
            }

            if (typeof(preCommand) != 'undefined') {
              bucketProgress.update(`${localDir}: running pre-command...`);
              child_process.execSync(preCommand, { stdio: 'inherit' });
            }

            const params = {
              maxAsyncS3: 5,
              localDir,
              deleteRemoved,
              followSymlinks: followSymlinks,
              getS3Params: (localFile, stat, cb) => {
                const s3Params = {};
                let onlyForEnv;

                if(Array.isArray(s.params)) {
                  s.params.forEach((param) => {
                    const glob = Object.keys(param)[0];
                    if(minimatch(localFile, `${path.resolve(localDir)}/${glob}`)) {
                      Object.assign(s3Params, this.extractMetaParams(param) || {});
                      onlyForEnv = s3Params['OnlyForEnv'] || onlyForEnv;
                    }
                  });
                  // to avoid parameter validation error
                  delete s3Params['OnlyForEnv'];
                }

                if (onlyForEnv && onlyForEnv !== this.options.env) {
                  cb(null, null);
                } else {
                  cb(null, s3Params);
                }
              },
              s3Params: {
                Bucket: bucketName,
                Prefix: this.getBucketPrefix(s),
                ACL: acl
              }
            };
            if (typeof(defaultContentType) != 'undefined') {
              Object.assign(params, {defaultContentType: defaultContentType})
            }

            bucketProgress.update(getProgressMessage());

            const uploader = this.client().uploadDir(params);
            uploader.on('error', (err) => {
              bucketProgress.remove();
              throw err;
            });
            uploader.on('progress', () => {
              if (uploader.progressTotal === 0) {
                return;
              }
              const current = Math.round((uploader.progressAmount / uploader.progressTotal) * 10) * 10;
              if (current > percent) {
                percent = current;
                bucketProgress.update(getProgressMessage());
              }
            });
            uploader.on('end', () => {
              bucketProgress.remove();
              resolve('done');
            });

            // Start the upload process
            uploader.start();
          });
        })
        .catch(e => {
          throw e;
        });
    });

    return BbPromise.all(promises);
  }

  // Restore other original methods...
  getBucketName(s) {
    if (s.bucketName) {
      return BbPromise.resolve(s.bucketName);
    }
    return resolveStackOutput(this.serverless, s.bucketNameKey);
  }

  getBucketPrefix(s) {
    return s.bucketPrefix || '';
  }

  extractMetaParams(param) {
    const value = param[Object.keys(param)[0]];
    return typeof value === 'object' ? value : {};
  }

  // Complete syncMetadata implementation - exactly like original
  syncMetadata(invokedAsCommand) {
    let s3Sync = this.serverless.service.custom.s3Sync;
    if (s3Sync.hasOwnProperty('buckets')) {
      s3Sync = s3Sync.buckets;
    }
    if (!Array.isArray(s3Sync)) {
      s3Sync = [s3Sync];
    }
    
    if (!Array.isArray(s3Sync)) {
      this.log.error('serverless-s3-sync requires at least one configuration entry in custom.s3Sync');
      return Promise.resolve();
    }

    const taskProgress = this.progress.create({ message: 'Syncing bucket metadata' });

    const servicePath = this.servicePath;
    const promises = s3Sync.map(async (s) => {
      let bucketPrefix = '';
      if (s.hasOwnProperty('bucketPrefix') && s.bucketPrefix.length > 0) {
        bucketPrefix = s.bucketPrefix.replace(/\/?$/, '').replace(/^\/?/, '/');
      }
      let acl = 'private';
      if (s.hasOwnProperty('acl')) {
        acl = s.acl;
      }
      
      if (s.hasOwnProperty('enabled') && s.enabled === false) {
        return null;
      }

      if ((!s.bucketName && !s.bucketNameKey) || !s.localDir) {
        throw 'Invalid custom.s3Sync';
      }
      
      const localDir = path.join(servicePath, s.localDir);
      let filesToSync = [];
      let ignoreFiles = ['.DS_Store'];
      
      if (Array.isArray(s.params)) {
        s.params.forEach((param) => {
          const glob = Object.keys(param)[0];
          let files = this.getLocalFiles(localDir, []);
          minimatch.match(files, `${path.resolve(localDir)}${path.sep}${glob}`, { matchBase: true }).forEach((match) => {
            const params = this.extractMetaParams(param);
            if (ignoreFiles.includes(match)) return;
            if (params['OnlyForEnv'] && params['OnlyForEnv'] !== this.options.env) {
              ignoreFiles.push(match);
              filesToSync = filesToSync.filter(e => e.name !== match);
              return;
            }
            // to avoid Unexpected Parameter error
            delete params['OnlyForEnv'];
            filesToSync = filesToSync.filter(e => e.name !== match);
            filesToSync.push({ name: match, params });
          });
        });
      }

      return this.getBucketName(s)
        .then(bucketName => {
          if (this.options && this.options.bucket && bucketName != this.options.bucket) {
            // if the bucket option is given, that means we're in the subcommand where we're
            // only syncing one bucket, so only continue if this bucket name matches
            return null;
          }

          const bucketDir = `${bucketName}${bucketPrefix == '' ? '' : bucketPrefix}/`;

          let percent = 0;
          const getProgressMessage = () => `${localDir}: sync bucket metadata to ${bucketDir} (${percent}%)`;
          const bucketProgress = this.progress.create({ message: getProgressMessage() });

          return Promise.all(filesToSync.map((file, index) => {
            return new Promise((resolve) => {
              let contentTypeObject = {};
              let detectedContentType = mime.getType(file.name);
              if (detectedContentType !== null || s.hasOwnProperty('defaultContentType')) {
                contentTypeObject.ContentType = detectedContentType ? detectedContentType : s.defaultContentType;
              }
              
              let params = {
                ...contentTypeObject,
                ...file.params,
                ...{
                  CopySource: encodeSpecialCharacters(toS3Path(file.name.replace(path.resolve(localDir) + path.sep, bucketDir))),
                  Key: encodeSpecialCharacters(toS3Path(file.name.replace(path.resolve(localDir) + path.sep, `${bucketPrefix ? bucketPrefix.replace(/^\//, '') + '/' : ''}`))),
                  Bucket: bucketName,
                  ACL: acl,
                  MetadataDirective: 'REPLACE'
                }
              };
              
              const uploader = this.client().copyObject(params);
              uploader.on('error', (err) => {
                bucketProgress.remove();
                throw err;
              });
              uploader.on('end', () => {
                const current = Math.round((index / filesToSync.length) * 10) * 10;
                if (current > percent) {
                  percent = current;
                  bucketProgress.update(getProgressMessage());
                }
                resolve('done');
              });
              uploader.start();
            });
          })).finally(() => {
            bucketProgress.remove();
          });
        });
    });

    return Promise.all(promises)
      .then(() => {
        if (invokedAsCommand) {
          this.log.success('Synced bucket metadata');
        } else {
          this.log.verbose('Synced bucket metadata');
        }
      })
      .finally(() => {
        taskProgress.remove();
      });
  }

  // Complete syncBucketTags implementation - exactly like original
  syncBucketTags(invokedAsCommand) {
    let s3Sync = this.serverless.service.custom.s3Sync;
    if (s3Sync.hasOwnProperty('buckets')) {
      s3Sync = s3Sync.buckets;
    }
    if (!Array.isArray(s3Sync)) {
      s3Sync = [s3Sync];
    }
    
    if (!Array.isArray(s3Sync)) {
      this.log.error('serverless-s3-sync requires at least one configuration entry in custom.s3Sync');
      return Promise.resolve();
    }

    const taskProgress = this.progress.create({ message: 'Updating bucket tags' });

    const promises = s3Sync.map(async (s) => {
      if (!s.bucketName && !s.bucketNameKey) {
        throw 'Invalid custom.s3Sync';
      }

      if (!s.bucketTags) {
        // bucket tags not configured for this bucket, skip it
        // so we don't require additional s3:getBucketTagging permissions
        return null;
      }

      // convert the tag key/value pairs into a TagSet structure for the putBucketTagging command
      const tagsToUpdate = Object.keys(s.bucketTags).map(tagKey => ({
        Key: tagKey,
        Value: s.bucketTags[tagKey]
      }));

      return this.getBucketName(s)
        .then(bucketName => {
          if (this.options && this.options.bucket && bucketName != this.options.bucket) {
            // if the bucket option is given, that means we're in the subcommand where we're
            // only syncing one bucket, so only continue if this bucket name matches
            return null;
          }

          const bucketProgress = this.progress.create({ message: `${bucketName}: sync bucket tags` });

          // AWS.S3 does not have an option to append tags to a bucket, it can only rewrite the whole set of tags
          // To avoid removing system tags set by other tools, we read the existing tags, merge our tags in the list
          // and then write them all back
          const getBucketTaggingCommand = new GetBucketTaggingCommand({ Bucket: bucketName });
          return this.client().s3Client.send(getBucketTaggingCommand)
            .then(data => data.TagSet || [])
            .catch(() => []) // If no tags exist, start with empty array
            .then(existingTagSet => {
              this.mergeTags(existingTagSet, tagsToUpdate);
              const putParams = {
                Bucket: bucketName,
                Tagging: {
                  TagSet: existingTagSet
                }
              };
              const putBucketTaggingCommand = new PutBucketTaggingCommand(putParams);
              return this.client().s3Client.send(putBucketTaggingCommand);
            })
            .finally(() => {
              bucketProgress.remove();
            });
        });
    });

    return Promise.all(promises)
      .then(() => {
        if (invokedAsCommand) {
          this.log.success('Updated bucket tags');
        } else {
          this.log.verbose('Updated bucket tags');
        }
      })
      .finally(() => {
        taskProgress.remove();
      });
  }

  remove() {
    let s3Sync = this.serverless.service.custom.s3Sync;
    if (!s3Sync) {
      return Promise.resolve();
    }

    if (s3Sync.hasOwnProperty('buckets')) {
      s3Sync = s3Sync.buckets;
    } else {
      s3Sync = [s3Sync];
    }

    const promises = s3Sync.map((s, index) => {
      return this.getBucketName(s)
        .then(bucketName => {
          const prefix = this.getBucketPrefix(s);
          
          // Security check: prevent accidental deletion of entire bucket contents
          if (!prefix || prefix.trim() === '') {
            throw new Error('bucketPrefix is required for remove operations to prevent accidental deletion of entire bucket contents');
          }
          
          return new Promise((resolve, reject) => {
            const params = {
              s3Params: {
                Bucket: bucketName,
                Prefix: prefix
              }
            };

            const uploader = this.client().deleteDir(params);
            uploader.on('error', (err) => {
              reject(err);
            });
            uploader.on('end', () => {
              resolve('done');
            });

            uploader.start();
          });
        });
    });

    return BbPromise.all(promises);
  }

  // Utility methods from original implementation
  getLocalFiles(dir, files) {
    try {
      fs.accessSync(dir, fs.constants.R_OK);
    } catch (e) {
      this.log.error(`The directory ${dir} does not exist.`);
      return files;
    }
    fs.readdirSync(dir).forEach(file => {
      let fullPath = path.join(dir, file);
      try {
        fs.accessSync(fullPath, fs.constants.R_OK);
      } catch (e) {
        this.log.error(`The file ${fullPath} does not exist.`);
        return;
      }
      if (fs.lstatSync(fullPath).isDirectory()) {
        this.getLocalFiles(fullPath, files);
      } else {
        files.push(fullPath);
      }
    });
    return files;
  }

  extractMetaParams(config) {
    const validParams = {};
    const keys = Object.keys(config);
    for (let i = 0; i < keys.length; i++) {
      Object.assign(validParams, config[keys[i]]);
    }
    return validParams;
  }

  mergeTags(existingTagSet, tagsToMerge) {
    tagsToMerge.forEach(tag => {
      const existingTag = existingTagSet.find(et => et.Key === tag.Key);
      if (existingTag) {
        existingTag.Value = tag.Value;
      } else {
        existingTagSet.push(tag);
      }
    });
  }
}

module.exports = ServerlessS3Sync;
