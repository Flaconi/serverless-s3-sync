#!/bin/bash

# Serverless S3 Sync Release Helper Script
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Emojis for better UX
ROCKET="🚀"
PACKAGE="📦"
CHECK="✅"
ERROR="❌"
WARNING="⚠️"
INFO="ℹ️"
GEAR="⚙️"

function show_help() {
    echo -e "${BLUE}Serverless S3 Sync Release Helper${NC}"
    echo ""
    echo -e "${YELLOW}Usage:${NC} $0 [COMMAND] [OPTIONS]"
    echo ""
    echo -e "${YELLOW}Commands:${NC}"
    echo "  release [VERSION_TYPE]    Create a new release"
    echo "  prerelease               Create a prerelease version"
    echo "  status                   Check release readiness"
    echo "  changelog               Generate changelog"
    echo "  test                    Run comprehensive tests"
    echo "  build                   Validate build process"
    echo "  clean                   Clean up release artifacts"
    echo "  help                    Show this help message"
    echo ""
    echo -e "${YELLOW}Version Types:${NC}"
    echo "  patch    - Bug fixes (1.0.0 → 1.0.1)"
    echo "  minor    - New features (1.0.0 → 1.1.0)"
    echo "  major    - Breaking changes (1.0.0 → 2.0.0)"
    echo "  custom   - Specify exact version"
    echo ""
    echo -e "${YELLOW}Examples:${NC}"
    echo "  $0 release patch"
    echo "  $0 release minor"
    echo "  $0 prerelease"
    echo "  $0 status"
    echo ""
    echo -e "${YELLOW}Environment Variables:${NC}"
    echo "  SKIP_TESTS=1             Skip test execution"
    echo "  SKIP_VALIDATION=1        Skip validation checks"
    echo "  DRY_RUN=1               Show what would be done"
    echo "  CUSTOM_VERSION=x.y.z     Use specific version"
}

function log_info() {
    echo -e "${BLUE}${INFO}${NC} $1"
}

function log_success() {
    echo -e "${GREEN}${CHECK}${NC} $1"
}

function log_warning() {
    echo -e "${YELLOW}${WARNING}${NC} $1"
}

function log_error() {
    echo -e "${RED}${ERROR}${NC} $1"
}

function log_step() {
    echo -e "${BLUE}${GEAR}${NC} $1"
}

function check_dependencies() {
    log_step "Checking dependencies..."
    
    # Check for required tools
    local missing_tools=()
    
    if ! command -v node &> /dev/null; then
        missing_tools+=("node")
    fi
    
    if ! command -v npm &> /dev/null; then
        missing_tools+=("npm")
    fi
    
    if ! command -v git &> /dev/null; then
        missing_tools+=("git")
    fi
    
    if [[ ${#missing_tools[@]} -gt 0 ]]; then
        log_error "Missing required tools: ${missing_tools[*]}"
        echo "Please install the missing tools and try again."
        exit 1
    fi
    
    # Check Node.js version
    local node_version=$(node --version | cut -d'v' -f2)
    local major_version=$(echo $node_version | cut -d'.' -f1)
    
    if [[ $major_version -lt 16 ]]; then
        log_error "Node.js version $node_version is not supported. Minimum required: 16.x"
        exit 1
    fi
    
    log_success "All dependencies are available"
}

function check_git_status() {
    log_step "Checking git repository status..."
    
    # Check if we're in a git repository
    if ! git rev-parse --git-dir > /dev/null 2>&1; then
        log_error "Not in a git repository"
        exit 1
    fi
    
    # Check for uncommitted changes
    if [[ -n "$(git status --porcelain)" ]]; then
        log_warning "Working directory has uncommitted changes:"
        git status --short
        
        if [[ "$SKIP_VALIDATION" != "1" ]]; then
            log_error "Please commit or stash your changes before releasing"
            exit 1
        else
            log_warning "Validation skipped - proceeding with uncommitted changes"
        fi
    fi
    
    # Check current branch
    local current_branch=$(git branch --show-current)
    log_info "Current branch: $current_branch"
    
    if [[ ! "$current_branch" =~ ^(main|master|release/.+|hotfix/.+)$ ]]; then
        log_warning "Releasing from '$current_branch' is unusual"
        log_info "Recommended branches: main, master, release/*, hotfix/*"
        
        if [[ "$SKIP_VALIDATION" != "1" ]]; then
            read -p "Continue anyway? (y/N): " -n 1 -r
            echo
            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                log_info "Release cancelled"
                exit 0
            fi
        fi
    fi
    
    log_success "Git status is clean"
}

function get_current_version() {
    node -p "require('./package.json').version"
}

function calculate_next_version() {
    local version_type=$1
    local current_version=$(get_current_version)
    
    case $version_type in
        "patch"|"minor"|"major")
            npm install -g semver > /dev/null 2>&1 || true
            if command -v semver &> /dev/null; then
                semver -i $version_type $current_version
            else
                # Fallback calculation
                IFS='.' read -ra VERSION_PARTS <<< "$current_version"
                local major=${VERSION_PARTS[0]}
                local minor=${VERSION_PARTS[1]}
                local patch=${VERSION_PARTS[2]:-0}
                
                case $version_type in
                    "patch") echo "$major.$minor.$((patch + 1))" ;;
                    "minor") echo "$major.$((minor + 1)).0" ;;
                    "major") echo "$((major + 1)).0.0" ;;
                esac
            fi
            ;;
        "custom")
            if [[ -n "$CUSTOM_VERSION" ]]; then
                echo "$CUSTOM_VERSION"
            else
                read -p "Enter custom version: " custom_version
                echo "$custom_version"
            fi
            ;;
        *)
            log_error "Invalid version type: $version_type"
            exit 1
            ;;
    esac
}

function run_tests() {
    if [[ "$SKIP_TESTS" == "1" ]]; then
        log_warning "Tests skipped by user request"
        return 0
    fi
    
    log_step "Running comprehensive tests..."
    
    # Install dependencies
    npm ci
    
    # Run test suite
    if npm test; then
        log_success "All tests passed"
    else
        log_error "Tests failed"
        exit 1
    fi
    
    # Run basic integration test
    if npm run test:basic; then
        log_success "Basic integration test passed"
    else
        log_error "Basic integration test failed"
        exit 1
    fi
    
    # Security audit
    if npm audit --audit-level high; then
        log_success "Security audit passed"
    else
        log_warning "Security audit found issues"
        read -p "Continue despite security issues? (y/N): " -n 1 -r
        echo
        if [[ ! $REPLY =~ ^[Yy]$ ]]; then
            log_info "Release cancelled due to security issues"
            exit 1
        fi
    fi
}

function generate_changelog() {
    log_step "Generating changelog..."
    
    local last_tag=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
    local changelog_file="/tmp/serverless-s3-sync-changelog.md"
    
    if [[ -n "$last_tag" ]]; then
        log_info "Last release: $last_tag"
        git log --pretty=format:"- %s (%h)" $last_tag..HEAD > "$changelog_file"
    else
        log_info "No previous releases found"
        git log --pretty=format:"- %s (%h)" --max-count=10 > "$changelog_file"
    fi
    
    if [[ -s "$changelog_file" ]]; then
        echo ""
        echo -e "${YELLOW}Recent changes:${NC}"
        cat "$changelog_file"
        echo ""
    else
        echo "- No significant changes found" > "$changelog_file"
    fi
    
    echo "$changelog_file"
}

function create_prerelease() {
    log_step "Creating prerelease version..."
    
    local current_version=$(get_current_version | sed 's/-beta\..*//')
    local timestamp=$(date +%Y%m%d%H%M%S)
    local prerelease_version="${current_version}-beta.${timestamp}"
    
    log_info "Prerelease version: $prerelease_version"
    
    if [[ "$DRY_RUN" == "1" ]]; then
        log_info "DRY RUN: Would create prerelease $prerelease_version"
        return 0
    fi
    
    # Update version
    npm version $prerelease_version --no-git-tag-version
    
    # Commit and tag
    git add package.json package-lock.json
    git commit -m "chore: bump version to $prerelease_version [skip ci]"
    git tag "v$prerelease_version"
    
    log_success "Created prerelease version: $prerelease_version"
    log_info "Push with: git push origin HEAD && git push origin v$prerelease_version"
}

function create_release() {
    local version_type=${1:-patch}
    
    log_step "Creating $version_type release..."
    
    local current_version=$(get_current_version)
    local next_version=$(calculate_next_version $version_type)
    
    log_info "Current version: $current_version"
    log_info "Next version: $next_version"
    
    # Validate version format
    if ! echo "$next_version" | grep -E '^[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9\.-]+)?$' > /dev/null; then
        log_error "Invalid version format: $next_version"
        exit 1
    fi
    
    # Check if version already exists
    if git tag -l "v$next_version" | grep -q "v$next_version"; then
        log_error "Version $next_version already exists as a git tag"
        exit 1
    fi
    
    if [[ "$DRY_RUN" == "1" ]]; then
        log_info "DRY RUN: Would create release $next_version"
        generate_changelog > /dev/null
        return 0
    fi
    
    # Generate changelog
    local changelog_file=$(generate_changelog)
    
    # Confirm release
    echo ""
    log_info "Release Summary:"
    echo "  Current version: $current_version"
    echo "  Next version: $next_version"
    echo "  Version type: $version_type"
    echo ""
    
    read -p "Proceed with release? (y/N): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        log_info "Release cancelled by user"
        exit 0
    fi
    
    # Update version
    npm version $next_version --no-git-tag-version
    
    # Commit and tag
    git add package.json package-lock.json
    git commit -m "chore: bump version to $next_version"
    git tag "v$next_version"
    
    log_success "Created release version: $next_version"
    log_info "Push with: git push origin HEAD && git push origin v$next_version"
    
    # Show next steps
    echo ""
    log_info "Next steps:"
    echo "1. Push the changes: git push origin HEAD"
    echo "2. Push the tag: git push origin v$next_version"
    echo "3. The CI/CD pipeline will automatically:"
    echo "   - Run tests"
    echo "   - Create GitHub release"
    echo "   - Publish to NPM"
}

function check_status() {
    log_step "Checking release readiness..."
    
    echo ""
    echo -e "${YELLOW}Repository Status:${NC}"
    
    # Current version
    local current_version=$(get_current_version)
    echo "  Current version: $current_version"
    
    # Git status
    local current_branch=$(git branch --show-current)
    echo "  Current branch: $current_branch"
    
    local commits_ahead=$(git rev-list --count HEAD ^origin/$current_branch 2>/dev/null || echo "unknown")
    echo "  Commits ahead of origin: $commits_ahead"
    
    # Last release
    local last_tag=$(git describe --tags --abbrev=0 2>/dev/null || echo "none")
    echo "  Last release: $last_tag"
    
    # Uncommitted changes
    local uncommitted=$(git status --porcelain | wc -l)
    echo "  Uncommitted changes: $uncommitted"
    
    echo ""
    echo -e "${YELLOW}Possible next versions:${NC}"
    echo "  Patch: $(calculate_next_version patch)"
    echo "  Minor: $(calculate_next_version minor)"
    echo "  Major: $(calculate_next_version major)"
    
    echo ""
    
    # Check for issues
    if [[ $uncommitted -gt 0 ]]; then
        log_warning "Repository has uncommitted changes"
    fi
    
    if [[ "$commits_ahead" != "0" && "$commits_ahead" != "unknown" ]]; then
        log_warning "Local branch is ahead of origin"
    fi
    
    if [[ ! "$current_branch" =~ ^(main|master|release/.+|hotfix/.+)$ ]]; then
        log_warning "Current branch '$current_branch' is not typical for releases"
    fi
    
    log_success "Status check complete"
}

function validate_build() {
    log_step "Validating build process..."
    
    # Install dependencies
    npm ci
    
    # Test package installation
    npm pack
    local pkg_file=$(ls *.tgz)
    
    # Create temp directory and test installation
    local temp_dir=$(mktemp -d)
    cd "$temp_dir"
    
    if npm install "$OLDPWD/$pkg_file"; then
        log_success "Package builds and installs correctly"
    else
        log_error "Package installation failed"
        cd "$OLDPWD"
        rm -rf "$temp_dir"
        exit 1
    fi
    
    cd "$OLDPWD"
    rm -rf "$temp_dir"
    rm -f "$pkg_file"
    
    log_success "Build validation completed"
}

function clean_artifacts() {
    log_step "Cleaning up release artifacts..."
    
    # Remove package files
    rm -f *.tgz
    
    # Remove temporary files
    rm -f /tmp/serverless-s3-sync-changelog.md
    
    # Clean npm cache
    npm cache clean --force 2>/dev/null || true
    
    log_success "Cleanup completed"
}

# Main script logic
function main() {
    # Parse command line arguments
    local command=${1:-help}
    local version_type=${2:-patch}
    
    case "$command" in
        "release")
            check_dependencies
            check_git_status
            run_tests
            create_release "$version_type"
            ;;
        "prerelease")
            check_dependencies
            check_git_status
            run_tests
            create_prerelease
            ;;
        "status")
            check_dependencies
            check_git_status
            check_status
            ;;
        "changelog")
            check_dependencies
            generate_changelog
            ;;
        "test")
            check_dependencies
            run_tests
            ;;
        "build")
            check_dependencies
            validate_build
            ;;
        "clean")
            clean_artifacts
            ;;
        "help"|*)
            show_help
            ;;
    esac
}

# Run main function if script is executed directly
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi