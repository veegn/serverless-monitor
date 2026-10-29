<template>
  <section class="settings-section full-width">
    <div class="section-title"><AppIcon name="gauge" :size="16" /><span>{{ trans.cloudflareSettings }}</span></div>
    <p class="text-muted text-sm">{{ trans.cloudflareUsageHint }}</p>
    <div class="form-row">
      <div class="form-group flex-1">
        <label class="form-label" for="cf-account-id">{{ trans.cloudflareAccountId }}</label>
        <input id="cf-account-id" v-model.trim="accountId" class="form-input" :placeholder="trans.cloudflareAccountIdPlaceholder" :disabled="busy" autocomplete="off">
      </div>
      <div class="form-group flex-1">
        <label class="form-label" for="cf-api-token">{{ trans.cloudflareTokenPlaceholder }}</label>
        <div class="password-input-wrapper">
          <input id="cf-api-token" v-model.trim="token" :type="tokenVisible ? 'text' : 'password'" class="form-input" :disabled="busy" autocomplete="new-password">
          <button type="button" class="password-toggle" :aria-label="trans.cloudflareTokenPlaceholder" :aria-pressed="tokenVisible" @click="tokenVisible = !tokenVisible"><AppIcon :name="tokenVisible ? 'eye-off' : 'eye'" :size="15" /></button>
        </div>
        <p class="text-muted text-sm">{{ trans.cloudflareTokenTip }}</p>
      </div>
    </div>
    <div class="settings-action-row">
      <button type="button" class="btn btn-primary" :disabled="busy || loadError" @click="queryUsage">{{ querying ? trans.loading : trans.queryD1Quota }}</button>
      <button type="button" class="btn" :disabled="busy || loadError || !credentialsChanged" @click="saveCredentials">{{ saving ? trans.saving : trans.saveCloudflareCredentials }}</button>
      <button v-if="loadError" type="button" class="btn" :disabled="busy" @click="loadCredentials">{{ trans.refresh }}</button>
      <span v-if="credentialsChanged" class="text-muted text-sm">{{ trans.cloudflareCredentialsNotSaved }}</span>
    </div>
    <p v-if="feedback" :class="feedbackError ? 'text-danger' : 'text-muted'" :role="feedbackError ? 'alert' : 'status'">{{ feedback }}</p>
    <div v-if="usage" class="settings-usage-table">
      <table>
        <caption class="text-muted text-sm">{{ trans.cloudflareUsageIncomplete }}</caption>
        <thead><tr><th scope="col">{{ trans.resourceAlertMetric }}</th><th scope="col">{{ trans.todayUsage }} (UTC)</th><th scope="col">{{ trans.yesterdayUsage }} (UTC)</th></tr></thead>
        <tbody>
          <tr v-for="metric in usageMetrics" :key="metric.key">
            <th scope="row">{{ metric.label }}</th>
            <td>{{ formatCount(usage.today?.[metric.key]) }}</td>
            <td>{{ formatCount(usage.yesterday?.[metric.key]) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppIcon from '../../../components/AppIcon.vue'
import { adminApi } from '../../../utils/api.js'

const props = defineProps({
  trans: { type: Object, required: true },
  selectedApiIndex: { type: Number, default: 0 }
})
const accountId = ref('')
const token = ref('')
const tokenVisible = ref(false)
const savedCredentials = ref({ accountId: '', token: '' })
const loading = ref(false)
const querying = ref(false)
const saving = ref(false)
const loadError = ref(false)
const feedback = ref('')
const feedbackError = ref(false)
const usage = ref(null)
let disposed = false
onBeforeUnmount(() => { disposed = true })
const busy = computed(() => loading.value || querying.value || saving.value)
const credentialsChanged = computed(() => accountId.value !== savedCredentials.value.accountId || token.value !== savedCredentials.value.token)
const usageMetrics = computed(() => [
  { key: 'rowsRead', label: `D1 · ${props.trans.d1RowsRead}` },
  { key: 'rowsWritten', label: `D1 · ${props.trans.d1RowsWritten}` },
  { key: 'workersRequests', label: props.trans.workersRequests },
  { key: 'durableObjectsRequests', label: props.trans.durableObjectsRequests }
])
const formatCount = (value) => Number.isFinite(Number(value)) && value !== null && value !== undefined ? Number(value).toLocaleString() : '—'
const showError = (error) => {
  feedbackError.value = true
  feedback.value = props.trans[error?.message] || error?.message || props.trans.operationFailed
}
watch([accountId, token], () => { usage.value = null; feedback.value = '' })

const loadCredentials = async () => {
  loading.value = true
  loadError.value = false
  try {
    const result = await adminApi({ action: 'get_settings' }, props.selectedApiIndex)
    if (disposed) return
    if (result.error) throw new Error(result.error)
    const settings = result.data?.settings || {}
    accountId.value = settings.cloudflare_account_id || ''
    token.value = settings.cloudflare_token || ''
    savedCredentials.value = { accountId: accountId.value, token: token.value }
  } catch (error) {
    if (!disposed) { loadError.value = true; showError(error) }
  } finally {
    if (!disposed) loading.value = false
  }
}

const queryUsage = async () => {
  if (busy.value) return
  if (!accountId.value || !token.value) {
    showError(new Error(!token.value ? 'cloudflareTokenRequired' : 'cloudflareAccountIdRequired'))
    return
  }
  querying.value = true
  feedback.value = ''
  usage.value = null
  try {
    const result = await adminApi({ action: 'd1_usage', cloudflare_account_id: accountId.value, cloudflare_token: token.value }, props.selectedApiIndex)
    if (disposed) return
    if (result.error) throw new Error(result.error)
    usage.value = result.data?.usage || null
  } catch (error) {
    if (!disposed) showError(error)
  } finally {
    if (!disposed) querying.value = false
  }
}

const saveCredentials = async () => {
  if (busy.value) return
  saving.value = true
  feedback.value = ''
  try {
    const result = await adminApi({ action: 'save_settings', settings: { cloudflare_account_id: accountId.value, cloudflare_token: token.value } }, props.selectedApiIndex)
    if (disposed) return
    if (result.error) throw new Error(result.error)
    savedCredentials.value = { accountId: accountId.value, token: token.value }
    feedbackError.value = false
    feedback.value = props.trans.cloudflareCredentialsSaved
  } catch (error) {
    if (!disposed) showError(error)
  } finally {
    if (!disposed) saving.value = false
  }
}
onMounted(loadCredentials)
</script>
