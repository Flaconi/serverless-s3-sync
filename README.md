# @flaconi/serverless-s3-sync

[![npm version](https://badge.fury.io/js/@flaconi/serverless-s3-sync.svg)](https://www.npmjs.com/package/@flaconi/serverless-s3-sync)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A plugin to sync local directories and S3 prefixes for Serverless Framework ⚡

**🚀 AWS SDK v3 Ready!** This is a modernized fork of the original `serverless-s3-sync` that has been updated to use AWS SDK v3, eliminating the deprecated AWS SDK v2 dependency that reached end-of-life in September 2024.

> 🧪 **Beta Testing in Progress!** We've updated the NPM trusted publisher configuration with the correct repository name. Testing automated OIDC releases now! [Join our beta testing program](./TESTING-BETA.md) to help us ensure everything works perfectly before the production release.
>
> **Install beta version**: `npm install @flaconi/serverless-s3-sync@beta`

## 🆕 What's New in v4.1

- ✅ **100% Feature Parity** - Complete compatibility with original k1LoW/serverless-s3-sync
- ✅ **Metadata Sync** - Update S3 object metadata without re-uploading files
- ✅ **Bucket Tags Management** - Manage S3 bucket tags with smart merging
- ✅ **Environment-Specific Deployments** - OnlyForEnv parameter support
- ✅ **Complete CLI Commands** - All original commands implemented
- ✅ **Pre-Command Support** - Run build steps before sync
- ✅ **Advanced Configuration** - enabled, defaultContentType, bucketTags options
- ✅ **Offline Development** - Full serverless-offline + serverless-s3-local support
- ✅ **Feature Compatibility Testing** - 24 test cases ensuring reliability

## 🔄 Migration from serverless-s3-sync

Simply replace in your `package.json`:

```diff
- "serverless-s3-sync": "^3.4.0"
+ "@flaconi/serverless-s3-sync": "^4.0.0"
```

And in your `serverless.yml`:

```diff
plugins:
- - serverless-s3-sync
+ - "@flaconi/serverless-s3-sync"
```

**No configuration changes needed!** All existing configurations work exactly the same.

## 📦 Installation

```bash
npm install --save @flaconi/serverless-s3-sync
```

## 🚀 Usage

Add the plugin to your `serverless.yml`:

```yaml
plugins:
  - "@flaconi/serverless-s3-sync"
```

Configure your S3 sync settings:

```yaml
custom:
  s3Sync:
    - bucketName: my-static-site-assets
      bucketPrefix: assets/
      localDir: dist/assets
      deleteRemoved: true
      acl: public-read
      followSymlinks: true
      enabled: true
      preCommand: npm run build
      defaultContentType: text/html
      params:
        - index.html:
            CacheControl: 'no-cache'
            OnlyForEnv: 'production'
        - "*.js":
            CacheControl: 'public, max-age=31536000'
        - "*.css":
            CacheControl: 'public, max-age=31536000'
      bucketTags:
        Environment: production
        Project: my-project
        Owner: my-team
```

## 📋 Configuration

All original configuration options are supported:

```yaml
custom:
  s3Sync:
    - bucketName: my-bucket # required
      bucketPrefix: assets/ # optional
      localDir: dist/assets # required
      deleteRemoved: true # optional, defaults to true
      acl: public-read # optional
      followSymlinks: true # optional
      defaultContentType: text/html # optional
      params: # optional
        - index.html:
            CacheControl: 'no-cache'
        - "*.js":
            CacheControl: 'public, max-age=31536000'
      bucketTags: # optional
        tagKey1: tagValue1
        tagKey2: tagValue2
      enabled: true # optional, defaults to true
```

## 🔧 Commands

All original commands work with additional new functionality:

```bash
# Complete sync (files + metadata + tags)
sls deploy

# Manual sync operations
sls s3sync                    # Sync files only
sls s3sync:metadata          # Sync metadata only
sls s3sync:tags              # Sync bucket tags only

# Per-bucket operations
sls s3sync:bucket:sync -b myBucket
sls s3sync:bucket:metadata -b myBucket  
sls s3sync:bucket:tags -b myBucket

# Deploy without sync
sls deploy --nos3sync

# Remove with cleanup
sls remove
sls remove --nos3sync         # Remove without cleaning S3
```

## 🌐 Offline Support

Works with `serverless-offline` and `serverless-s3-local`:

```yaml
custom:
  s3Sync:
    endpoint: http://localhost:4569 # for local S3
    buckets:
      - bucketName: my-local-bucket
        localDir: dist/assets
```

## �� Differences from Original

- **AWS SDK v3** instead of v2 (`@auth0/s3`)
- **Node.js 16+** requirement (was 10+)
- **Improved error handling** and logging
- **Better TypeScript support**
- **Smaller bundle size** due to tree-shaking

## 🤝 Contributing

This project maintains backward compatibility with the original `serverless-s3-sync`. We welcome:

- Bug fixes
- Feature enhancements
- Documentation improvements
- Performance optimizations

## CI/CD & Release Management

This project uses enterprise-grade CI/CD automation with:

- **Smart Testing** - Multi-environment testing (Node.js 18-20) with change detection
- **Automated Releases** - Semantic versioning with prereleases and production releases
- **Manual Control** - Interactive release workflows via GitHub Actions
- **External Triggers** - API-driven releases from dependent repositories
- **Developer Tools** - Local release helper: `./release.sh status|release|prerelease`

**Release Commands:**
```bash
# Local development
./release.sh status              # Check release readiness
./release.sh release patch       # Create patch release (1.0.0 → 1.0.1)
./release.sh prerelease          # Create beta with timestamp

# Or use npm scripts
npm run release:patch            # Same as above
npm run test:ci                  # Run full CI test suite
```

**GitHub Actions:**
- Go to **Actions** → **Manual Release** for interactive releases
- Push to main branch for automatic prereleases
- Create version tags for production releases

## 📈 What Makes This Different

The original `serverless-s3-sync` plugin depends on `@auth0/s3` which uses AWS SDK v2. AWS ended support for SDK v2 in September 2024, creating security and maintenance concerns for projects using it.

This fork:
- ✅ **100% Feature Parity** - Every feature from the original plugin
- ✅ **Zero Breaking Changes** - Drop-in replacement  
- ✅ **Modern AWS SDK v3** - Latest security and performance
- ✅ **Enhanced Functionality** - Metadata sync, bucket tags, environment-specific deployments
- ✅ **Production Ready** - Comprehensive test suite with 24 test cases
- ✅ **Long-term Support** - Actively maintained by Flaconi

## 🏢 About Flaconi

This package is maintained by [Flaconi GmbH](https://flaconi.de), a leading beauty e-commerce platform. We're committed to maintaining this package and keeping it up-to-date with the latest AWS SDK versions.

## 📄 License

MIT - same as the original project

## 🙏 Credits

Based on the excellent work by [k1LoW](https://github.com/k1LoW) and contributors of the original [`serverless-s3-sync`](https://github.com/k1LoW/serverless-s3-sync) project.

## 🔗 Links

- [Original Project](https://github.com/k1LoW/serverless-s3-sync)
- [AWS SDK v3 Migration Guide](https://docs.aws.amazon.com/sdk-for-javascript/v3/developer-guide/migrating-to-v3.html)
- [Serverless Framework](https://serverless.com/)

---

**Need help?** Open an issue or check our [documentation](https://github.com/Flaconi/serverless-s3-sync).
