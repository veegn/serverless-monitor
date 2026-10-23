<template>
  <div class="modal-overlay" :class="{ active: show }">
    <div class="modal-dialog">
      <div class="modal-header">
        <div class="modal-title">⚡ {{ trans.autoDiscoveryTitle || '自动发现部署脚本' }}</div>
        <button class="modal-close" @click="$emit('close')">✕</button>
      </div>

      <div class="auto-discovery-desc">
        {{ trans.autoDiscoveryDesc || '在目标机器直接执行此命令，探针启动后将通过授权 Key 自动注册并上线，无需预先在后台录入服务器。' }}
      </div>

      <!-- Warning if auto registration is disabled -->
      <div v-if="!isAutoRegisterEnabled" class="alert alert-info mb-3">
        <div class="flex items-center justify-between width-full">
          <span>⚠️ {{ trans.autoDiscoveryNeedEnable || '自动注册功能当前未启用，请先开启。' }}</span>
          <button
            type="button"
            class="btn btn-sm btn-primary ml-2 flex-shrink-0"
            :disabled="enablingAutoRegister"
            @click="handleEnableAutoRegister"
          >
            {{ enablingAutoRegister ? '⏳ ...' : (trans.enableAutoDiscoveryNow || '立即开启') }}
          </button>
        </div>
      </div>

      <!-- Token & Expiration Status Card -->
      <div class="auto-discovery-token-box">
        <div class="token-box-header">
          <span class="token-box-label">
            🔑 {{ trans.autoRegisterToken || '授权 Key' }}
            <span v-if="tokenStatus.isValid" class="token-badge badge-valid">
              🟢 {{ trans.autoRegisterTokenValid || '有效至' }} {{ tokenStatus.formattedExpires }} ({{ trans.remaining || '剩余' }} {{ tokenStatus.remainingMinutes }})
            </span>
            <span v-else-if="tokenStatus.isExpired" class="token-badge badge-expired">
              🔴 {{ trans.autoRegisterTokenExpired || '已过期（需重新生成）' }}
            </span>
            <span v-else class="token-badge badge-empty">
              ⚪ {{ trans.autoRegisterTokenNotGenerated || '未生成' }}
            </span>
          </span>

          <button
            type="button"
            class="btn btn-sm btn-secondary"
            :disabled="generatingToken"
            @click="$emit('generate-token', false)"
          >
            {{ generatingToken ? '⏳ ...' : '🔄 ' + (settings.auto_register_token ? (trans.regenerateToken || '重新生成 Key') : (trans.generateToken || '生成授权 Key')) }}
          </button>
        </div>

        <div class="password-input-wrapper mt-2">
          <input
            type="text"
            readonly
            :value="tokenVisible ? (settings.auto_register_token || '') : (settings.auto_register_token ? '••••••••••••••••••••••••' : '')"
            class="form-input"
            :placeholder="trans.autoRegisterTokenNotGenerated || '未生成授权 Key'"
          >
          <button
            v-if="settings.auto_register_token"
            type="button"
            class="password-toggle"
            @click="tokenVisible = !tokenVisible"
          >
            {{ tokenVisible ? '🙈' : '👁️' }}
          </button>
        </div>
      </div>

      <!-- Settings Controls -->
      <div class="form-row">
        <div class="form-group flex-1">
          <label class="form-label">{{ trans.targetOs }}</label>
          <select v-model="targetOs" class="form-select">
            <option value="linux">Linux (systemd)</option>
            <option value="unix">OpenWrt/Alpine/Synology DSM/FreeBSD</option>
            <option value="mac">macOS</option>
            <option value="windows">Windows</option>
            <option value="docker">Docker</option>
          </select>
        </div>

        <div class="form-group flex-1">
          <label class="form-label">
            Agent {{ trans.version }}
            <HelpTooltip :text="targetOs === 'docker' ? trans.dockerVersionTip : trans.installVersionTip" />
          </label>
          <input
            type="text"
            v-model="installVersion"
            class="form-input"
            :placeholder="targetOs === 'docker' ? 'latest' : (trans.installVersionPlaceholder || '默认最新版')"
          >
        </div>
      </div>

      <!-- Row 2: Linux Mode & Proxy (if not docker) -->
      <div v-if="targetOs !== 'docker'" class="form-row">
        <div v-if="targetOs === 'linux'" class="form-group flex-1">
          <label class="form-label">
            {{ trans.installMode }}
            <HelpTooltip :text="trans.nonRootInstallTip" />
          </label>
          <select v-model="installMode" class="form-select">
            <option value="current-user">{{ trans.installModeCurrentUser }}</option>
            <option value="cfsm-user">{{ trans.installModeCfsmUser }}</option>
          </select>
        </div>

        <div class="form-group flex-1">
          <label class="form-label">
            {{ trans.ghProxy }}
            <HelpTooltip :text="trans.ghProxyTip" />
          </label>
          <select v-model="selectedGhProxy" class="form-select">
            <option v-for="option in ghProxyOptions" :key="option.value" :value="option.value">{{ option.label }}</option>
            <option :value="CUSTOM_GH_PROXY_VALUE">{{ trans.custom || 'Custom' }}</option>
          </select>
          <input
            v-if="showCustomGhProxy"
            type="text"
            v-model="installGhProxy"
            class="form-input mt-2"
            :placeholder="trans.ghProxyPlaceholder || 'https://proxy.example.com/'"
          >
        </div>
      </div>

      <!-- Row 3: Node Name & Group Info -->
      <div class="form-row">
        <div class="form-group flex-1">
          <label class="form-label">
            {{ trans.customNodeName || '指定节点名称 (可选)' }}
            <HelpTooltip :text="trans.customNodeNameTip || '留空则自动使用目标机器的主机名 (Hostname)'" />
          </label>
          <input
            type="text"
            v-model="customNodeName"
            class="form-input"
            :placeholder="trans.customNodeNameTip || '留空则自动使用目标机器 Hostname'"
          >
        </div>

        <div class="form-group flex-1">
          <label class="form-label">
            {{ trans.autoUpdate }}
          </label>
          <div class="flex items-center gap-2 mt-2">
            <input type="checkbox" id="auto-discovery-update" v-model="autoUpdate" class="checkbox-accent-green">
            <label for="auto-discovery-update" class="cursor-pointer text-xs">{{ trans.autoUpdate }} (-auto_update=1)</label>
          </div>
          <div class="auto-discovery-group-hint">
            {{ trans.autoRegisterDefaultGroup || '默认分组' }}: <strong>{{ settings?.auto_register_default_group || 'Default' }}</strong>
          </div>
        </div>
      </div>

      <!-- Command Output Area -->
      <div class="form-group mt-2">
        <label class="form-label flex items-center justify-between">
          <span>{{ trans.autoRegisterCommand || '自动发现部署命令' }}</span>
          <span class="text-muted text-xs">{{ trans.autoRegisterCommandTip || '在目标服务器直接执行此命令即可' }}</span>
        </label>
        <div class="cmd-output-wrapper" :class="{ copied: copiedCmd }">
          <span class="cmd-prompt">{{ targetOs === 'windows' ? 'PS' : '$' }}</span>
          <pre class="cmd-output">{{ installCommand }}</pre>
        </div>
      </div>

      <div class="modal-footer flex-justify-between">
        <div class="flex items-center gap-2">
          <button @click="handleCopy" class="btn btn-primary">
            {{ copiedCmd ? '✅ ' + trans.copied : '📋 ' + (trans.clickToCopy || '一键复制命令') }}
          </button>
          <button @click="$emit('go-to-settings')" class="btn btn-secondary">
            ⚙️ {{ trans.autoRegisterSettings || '详细设置' }}
          </button>
        </div>
        <button @click="$emit('close')" class="btn">{{ trans.cancel || '关闭' }}</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { copyTextToClipboard } from '../../../utils/clipboard.js'
import HelpTooltip from '../../../components/HelpTooltip.vue'

const props = defineProps({
  show: { type: Boolean, default: false },
  trans: { type: Object, required: true },
  settings: { type: Object, default: () => ({}) },
  selectedApiBase: { type: String, default: '' },
  generatingToken: { type: Boolean, default: false }
})

const emit = defineEmits([
  'close',
  'generate-token',
  'enable-auto-register',
  'alert-message',
  'go-to-settings'
])

const targetOs = ref('linux')
const installMode = ref('current-user')
const installGhProxy = ref('')
const installVersion = ref('')
const customNodeName = ref('')
const autoUpdate = ref(false)
const tokenVisible = ref(false)
const copiedCmd = ref(false)
const enablingAutoRegister = ref(false)

const currentTime = ref(Date.now())
let timer = null

onMounted(() => {
  timer = setInterval(() => {
    currentTime.value = Date.now()
  }, 1000)
})

onBeforeUnmount(() => {
  if (timer) clearInterval(timer)
})

const CUSTOM_GH_PROXY_VALUE = '__custom__'
const ghProxyOptions = [
  { value: '', label: props.trans.ghProxyPlaceholder || '海外直连 / Direct' },
  { value: 'https://ghfast.top/', label: 'https://ghfast.top/' },
  { value: 'https://ghproxy.net/', label: 'https://ghproxy.net/' },
  { value: 'https://gh.llkk.cc/', label: 'https://gh.llkk.cc/' },
  { value: 'https://gh-proxy.com/', label: 'https://gh-proxy.com/' }
]

const manualCustomGhProxy = ref(false)
const isKnownGhProxy = (value) => ghProxyOptions.some(option => option.value === String(value || '').trim())

const selectedGhProxy = computed({
  get: () => {
    const currentProxy = String(installGhProxy.value || '').trim()
    if (manualCustomGhProxy.value || (!isKnownGhProxy(currentProxy) && currentProxy)) {
      return CUSTOM_GH_PROXY_VALUE
    }
    return currentProxy
  },
  set: (value) => {
    if (value === CUSTOM_GH_PROXY_VALUE) {
      manualCustomGhProxy.value = true
      if (isKnownGhProxy(installGhProxy.value)) {
        installGhProxy.value = ''
      }
      return
    }
    manualCustomGhProxy.value = false
    installGhProxy.value = value
  }
})

const showCustomGhProxy = computed(() => selectedGhProxy.value === CUSTOM_GH_PROXY_VALUE)

const isAutoRegisterEnabled = computed(() => {
  return props.settings?.auto_register_enabled === true || props.settings?.auto_register_enabled === 'true'
})

const tokenStatus = computed(() => {
  const token = props.settings?.auto_register_token
  const expires = Number(props.settings?.auto_register_token_expires) || 0
  if (!token || !expires) {
    return { isValid: false, isExpired: false, isEmpty: true }
  }
  const now = currentTime.value
  if (now > expires) {
    return { isValid: false, isExpired: true, isEmpty: false }
  }
  const diffSec = Math.floor((expires - now) / 1000)
  const remainingMinutes = Math.max(1, Math.ceil(diffSec / 60))
  const date = new Date(expires)
  const pad = n => String(n).padStart(2, '0')
  const formattedExpires = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  return {
    isValid: true,
    isExpired: false,
    isEmpty: false,
    formattedExpires,
    remainingMinutes: `${remainingMinutes}m`
  }
})

const buildGhRawUrl = (proxy, path) => {
  const base = 'https://raw.githubusercontent.com'
  if (!proxy) return `${base}${path}`
  const cleanProxy = proxy.replace(/\/$/, '')
  return `${cleanProxy}/${base}${path}`
}

const quotePosixShellArg = (value) => `'${String(value).replaceAll("'", `'"'"'`)}'`

const quotePowerShellArg = (value) => `'${String(value).replaceAll("'", "''")}'`

const quotePosixDoubleShellArg = (value) => `"${String(value)
  .replaceAll('\\', '\\\\')
  .replaceAll('"', '\\"')
  .replaceAll('$', '\\$')
  .replaceAll('`', '\\`')}"`

const buildInstallAsCfsmCommand = (command, runStep) => {
  const lines = [
    '(',
    'set -e',
    `if [ ! -d /run/systemd/system ] || ! command -v systemctl >/dev/null 2>&1 || ! command -v loginctl >/dev/null 2>&1 || ! command -v useradd >/dev/null 2>&1 || ! command -v runuser >/dev/null 2>&1; then echo ${quotePosixDoubleShellArg(props.trans.dedicatedUserSystemdRequired || 'Systemd user service capability required')} >&2; exit 1; fi`,
    'if [ "$(id -u)" -eq 0 ]; then',
    '  as_root() { "$@"; }',
    'elif command -v sudo >/dev/null 2>&1; then',
    '  as_root() { sudo "$@"; }',
    'else',
    `  echo ${quotePosixDoubleShellArg(props.trans.nonRootInstallSudoRequired || 'sudo required')} >&2; exit 1`,
    'fi'
  ]

  lines.push(
    'id cfsm >/dev/null 2>&1 || as_root useradd -r -m -s /bin/bash cfsm',
    'CFSM_UID=$(id -u cfsm)',
    'CFSM_HOME=$(getent passwd cfsm | cut -d: -f6); [ -n "${CFSM_HOME}" ] || CFSM_HOME=/home/cfsm',
    'as_root loginctl enable-linger cfsm',
    'as_root systemctl start user@${CFSM_UID}.service 2>/dev/null || true'
  )

  const runuserCommand = `runuser -u cfsm -- env HOME="\${CFSM_HOME}" XDG_RUNTIME_DIR="/run/user/\${CFSM_UID}" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/\${CFSM_UID}/bus" sh -c ${quotePosixDoubleShellArg(command)}`
  lines.push(
    'if [ "$(id -u)" -eq 0 ]; then',
    `  ${runuserCommand}`,
    'else',
    `  sudo ${runuserCommand}`,
    'fi',
    ')'
  )
  return lines.join('\n')
}

const installCommand = computed(() => {
  const HOST = (props.selectedApiBase || (typeof window !== 'undefined' ? window.location.origin : '')).replace(/\/$/, '')
  const token = props.settings?.auto_register_token || ''
  if (!token) return props.trans.autoRegisterTokenNotGenerated || '请先生成授权 Key'

  const proxy = installGhProxy.value.trim()
  const version = installVersion.value.trim()
  const name = customNodeName.value.trim()
  const autoUpdateFlag = autoUpdate.value ? 1 : 0

  if (targetOs.value === 'windows') {
    const params = ['install']
    if (proxy) params.push(quotePowerShellArg(`--install-ghproxy=${proxy}`))
    if (version) params.push(quotePowerShellArg(`--install-version=${version}`))
    params.push(
      `-token='${token}'`,
      `-url='${HOST}/update'`
    )
    if (name) params.push(`-name=${quotePowerShellArg(name)}`)
    if (autoUpdateFlag) params.push(`-auto_update='1'`)
    const ghUrl = buildGhRawUrl(proxy, '/veegn/serverless-monitor-agent/refs/heads/main/install.ps1')
    return `$script = "$env:TEMP\\install-sma.ps1"; Invoke-WebRequest -Uri ${quotePowerShellArg(ghUrl)} -OutFile $script -UseBasicParsing; PowerShell -ExecutionPolicy Bypass -File $script ${params.join(' ')}`
  }

  if (targetOs.value === 'docker') {
    const safeTag = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(version) ? version : 'latest'
    const image = `ghcr.io/veegn/serverless-monitor-agent:${safeTag}`
    const envs = [
      `  -e SECRET=${quotePosixShellArg(token)} -e WORKER_URL=${quotePosixShellArg(`${HOST}/update`)} \\`
    ]
    if (name) {
      envs.push(`  -e SERVER_NAME=${quotePosixShellArg(name)} \\`)
    }
    return [
      'docker run -d --name sma --restart=unless-stopped --network=host \\',
      '  -v sma-data:/data \\',
      ...envs,
      `  ${image}`
    ].join('\n')
  }

  const params = ['install']
  if (proxy) params.push(quotePosixShellArg(`--install-ghproxy=${proxy}`))
  if (version) params.push(quotePosixShellArg(`--install-version=${version}`))
  params.push(
    `-token='${token}'`,
    `-url=${HOST}/update`
  )
  if (name) params.push(`-name=${quotePosixShellArg(name)}`)
  if (autoUpdateFlag) params.push(`-auto_update=1`)

  const ghUrl = buildGhRawUrl(proxy, '/veegn/serverless-monitor-agent/refs/heads/main/install.sh')
  const baseCmd = `curl -fsSL ${quotePosixShellArg(ghUrl)} | sh -s -- ${params.join(' ')}`

  if (targetOs.value === 'linux' && installMode.value === 'cfsm-user') {
    return buildInstallAsCfsmCommand(baseCmd, props.trans.nonRootInstallRunStep)
  }
  return baseCmd
})

const handleCopy = async () => {
  if (tokenStatus.value.isExpired) {
    emit('alert-message', props.trans.autoRegisterTokenExpiredAlert || '授权 Key 已过期，请先重新生成授权 Key')
    return
  }
  if (!props.settings?.auto_register_token) {
    emit('alert-message', props.trans.autoRegisterTokenNotGenerated || '请先生成授权 Key')
    return
  }
  const cmd = installCommand.value
  const copied = await copyTextToClipboard(cmd)
  if (copied) {
    copiedCmd.value = true
    setTimeout(() => { copiedCmd.value = false }, 2000)
    emit('alert-message', props.trans.autoDiscoveryCopied || '自动发现部署脚本已复制到剪贴板 (有效时间 30 分钟)')
  } else {
    emit('alert-message', props.trans.httpsRequired || '复制失败，请手动复制')
  }
}

const handleEnableAutoRegister = async () => {
  if (enablingAutoRegister.value) return
  enablingAutoRegister.value = true
  try {
    emit('enable-auto-register')
  } finally {
    setTimeout(() => {
      enablingAutoRegister.value = false
    }, 1000)
  }
}

watch(
  () => props.show,
  (show) => {
    if (show) {
      copiedCmd.value = false
      const token = props.settings?.auto_register_token
      const expires = Number(props.settings?.auto_register_token_expires) || 0
      if (!token || expires <= Date.now()) {
        emit('generate-token', true)
      }
    }
  }
)
</script>
