<template>
  <div id="copyModal" class="modal-overlay" :class="{ active: show }">
    <div class="modal-dialog">
      <div class="modal-header">
        <div class="modal-title">{{ currentServerName }}</div>
        <button class="modal-close" @click="$emit('close')">✕</button>
      </div>

      <div class="form-row">
        <div class="form-group flex-1">
          <label class="form-label">{{ trans.targetOs }}</label>
          <select :value="targetOs" class="form-select" @change="$emit('update:target-os', $event.target.value)">
            <option value="linux">Linux (systemd)</option>
            <option value="unix">OpenWrt/Alpine/Synology DSM/FreeBSD</option>
            <option value="mac">macOS</option>
            <option value="windows">Windows</option>
          </select>
        </div>

        <div class="form-group flex-1">
          <label class="form-label">
            Agent {{ trans.version }}
            <HelpTooltip :text="trans.installVersionTip" />
          </label>
          <input
            type="text"
            :value="installVersion"
            class="form-input"
            :placeholder="trans.installVersionPlaceholder"
            @input="$emit('update:install-version', $event.target.value)"
          >
        </div>
      </div>

      <div v-if="targetOs === 'linux'" class="form-row">
        <div class="form-group flex-1">
          <label class="form-label">
            {{ trans.installMode }}
            <HelpTooltip :text="trans.nonRootInstallTip" />
          </label>
          <select :value="installMode" class="form-select" @change="$emit('update:install-mode', $event.target.value)">
            <option value="current-user">{{ trans.installModeCurrentUser }}</option>
            <option value="cfsm-user">{{ trans.installModeCfsmUser }}</option>
          </select>
        </div>
      </div>

      <div class="server-config-tip mb-3">
        💡 {{ trans.copyModalAgentTip || '探针运行参数（采集间隔、上报模式、Ping 节点、流量重置等）由后端动态下发，启动后自动拉取生效，无需写入命令中。如需修改请点击下方“编辑”。' }}
      </div>

      <div class="form-group">
        <div class="cmd-output-wrapper" :class="{ copied: copiedCmd }">
          <span class="cmd-prompt">{{ targetOs === 'windows' ? 'PS' : '$' }}</span>
          <pre class="cmd-output">{{ installCommand }}</pre>
        </div>
      </div>

      <div class="modal-footer flex-justify-between">
        <div class="flex items-center gap-2">
          <button @click="$emit('copy-cmd')" class="btn btn-primary">{{ copiedCmd ? '✅ ' + trans.copied : '📋 ' + trans.copy }}</button> &nbsp; <button @click="$emit('open-edit-from-copy')" class="btn btn-blue">✏️ {{ trans.edit }}</button>
        </div>
        <button @click="$emit('close')" class="btn">{{ trans.cancel }}</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'
import HelpTooltip from '../../../components/HelpTooltip.vue'

const props = defineProps({
  trans: { type: Object, required: true },
  settings: { type: Object, default: () => ({}) },
  show: { type: Boolean, default: false },
  currentServerName: { type: String, default: '' },
  targetOs: { type: String, default: 'linux' },
  installMode: { type: String, default: 'current-user' },
  installVersion: { type: String, default: '' },
  installCommand: { type: String, default: '' },
  copiedCmd: { type: Boolean, default: false }
})

const emit = defineEmits([
  'close',
  'copy-cmd',
  'open-edit-from-copy',
  'update:target-os',
  'update:install-mode',
  'update:install-version'
])
</script>
