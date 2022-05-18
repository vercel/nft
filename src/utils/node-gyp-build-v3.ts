var fs = require('fs')
var path = require('path')
var os = require('os')

// Workaround to fix webpack's build warnings: 'the request of a dependency is an expression'
// @ts-ignore
var runtimeRequire = typeof __webpack_require__ === 'function' ? __non_webpack_require__ : require // eslint-disable-line

var prebuildsOnly = !!process.env.PREBUILDS_ONLY
var abi = process.versions.modules // TODO: support old node where this is undef
var runtime = isElectron() ? 'electron' : 'node'
var arch = os.arch()
var platform = os.platform()
var libc = process.env.LIBC || (isAlpine(platform) ? 'musl' : 'glibc')
// @ts-ignore
var armv = process.env.ARM_VERSION || (arch === 'arm64' ? '8' : process.config.variables.arm_version) || ''

module.exports = load

function load (dir: string) {
  return runtimeRequire(load.path(dir))
}

load.path = function (dir: string | undefined) {
  dir = path.resolve(dir || '.')

  try {
    var name = runtimeRequire(path.join(dir, 'package.json')).name.toUpperCase().replace(/-/g, '_')
    if (process.env[name + '_PREBUILD']) dir = process.env[name + '_PREBUILD']
  } catch (err) {}

  if (!prebuildsOnly) {
    var release = getFirst(path.join(dir, 'build/Release'), matchBuild)
    if (release) return release

    var debug = getFirst(path.join(dir, 'build/Debug'), matchBuild)
    if (debug) return debug
  }

  var names = [platform + '-' + arch]
  if (libc) names.push(platform + libc + '-' + arch)

  if ((arch === 'arm' || arch === 'arm64') && armv) {
    names.forEach(function (name: string) {
      names.push(name + '-v' + armv)
    })
  }

  // Find most specific flavor first
  for (var i = names.length; i--;) {
    var prebuild = getFirst(path.join(dir, 'prebuilds/' + names[i]), matchPrebuild)
    if (prebuild) return prebuild

    var napiRuntime = getFirst(path.join(dir, 'prebuilds/' + names[i]), matchNapiRuntime)
    if (napiRuntime) return napiRuntime

    var napi = getFirst(path.join(dir, 'prebuilds/' + names[i]), matchNapi)
    if (napi) return napi
  }

  throw new Error('No native build was found for runtime=' + runtime + ' abi=' + abi + ' platform=' + platform + libc + ' arch=' + arch)
}

// @ts-ignore
function getFirst (dir, filter) {
  try {
    var files = fs.readdirSync(dir).filter(filter)
    return files[0] && path.join(dir, files[0])
  } catch (err) {
    return null
  }
}

function matchNapiRuntime (name: string) {
  return name === runtime + '-napi.node'
}

function matchNapi (name: string) {
  return name === 'node-napi.node'
}

function matchPrebuild (name: string) {
  var parts = name.split('-')
  return parts[0] === runtime && parts[1] === abi + '.node'
}

function matchBuild (name: string) {
  return /\.node$/.test(name)
}

function isElectron () {
  if (process.versions && process.versions.electron) return true
  if (process.env.ELECTRON_RUN_AS_NODE) return true
  // @ts-ignore
  return typeof window !== 'undefined' && window.process && window.process.type === 'renderer'
}

function isAlpine (platform: string) {
  return platform === 'linux' && fs.existsSync('/etc/alpine-release')
}