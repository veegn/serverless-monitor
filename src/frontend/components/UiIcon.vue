<template>
  <svg
    :class="['ui-icon', `ui-icon-${name}`]"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    :stroke-width="strokeWidth"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <!-- 价格/账单图标 (Wallet/Price) -->
    <template v-if="name === 'price'">
      <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4" />
      <path d="M3 5v14a2 2 0 0 0 2 2h16v-5" />
      <path d="M18 12a2 2 0 0 0 0 4h4v-4Z" />
    </template>

    <!-- 到期时间图标 (Calendar) -->
    <template v-else-if="name === 'expire' || name === 'calendar'">
      <rect width="18" height="18" x="3" y="4" rx="2" ry="2" />
      <line x1="16" x2="16" y1="2" y2="6" />
      <line x1="8" x2="8" y1="2" y2="6" />
      <line x1="3" x2="21" y1="10" y2="10" />
    </template>

    <!-- 流量配额/包图标 (Package) -->
    <template v-else-if="name === 'package' || name === 'box'">
      <path d="m7.5 4.27 9 5.15" />
      <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
      <path d="m3.3 7 8.7 5 8.7-5" />
      <path d="M12 22V12" />
    </template>

    <!-- 未知地区旗帜图标 (Flag outline) -->
    <template v-else-if="name === 'flag'">
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <line x1="4" x2="4" y1="22" y2="15" />
    </template>

    <!-- 上行/上传箭头 (Arrow Up) -->
    <template v-else-if="name === 'arrow-up' || name === 'upload'">
      <line x1="12" x2="12" y1="19" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </template>

    <!-- 下行/下载箭头 (Arrow Down) -->
    <template v-else-if="name === 'arrow-down' || name === 'download'">
      <line x1="12" x2="12" y1="5" y2="19" />
      <polyline points="19 12 12 19 5 12" />
    </template>

    <!-- 运行时长/时钟图标 (Clock / Uptime) -->
    <template v-else-if="name === 'clock' || name === 'uptime' || name === 'time'">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </template>

    <!-- 操作系统/监视器 (Monitor / OS) -->
    <template v-else-if="name === 'os' || name === 'monitor'">
      <rect width="20" height="14" x="2" y="3" rx="2" />
      <line x1="8" x2="16" y1="21" y2="21" />
      <line x1="12" x2="12" y1="17" y2="21" />
    </template>

    <!-- 内核/组件图标 (Puzzle / Kernel) -->
    <template v-else-if="name === 'kernel' || name === 'puzzle'">
      <path d="M19.439 7.85c-.049-.322-.28-.58-.594-.652l-2.022-.46a1.5 1.5 0 0 1-1.123-1.123l-.46-2.022a.75.75 0 0 0-.652-.594C14.265 2.95 13.92 2.5 13.5 2.5s-.765.45-1.088.5a.75.75 0 0 0-.652.594l-.46 2.022a1.5 1.5 0 0 1-1.123 1.123l-2.022.46a.75.75 0 0 0-.594.652C7.51 8.17 7.06 8.515 7.06 8.935s.45.765.5 1.088a.75.75 0 0 0 .594.652l2.022.46a1.5 1.5 0 0 1 1.123 1.123l.46 2.022a.75.75 0 0 0 .652.594c.323.05.668.5 1.088.5s.765-.45 1.088-.5a.75.75 0 0 0 .652-.594l.46-2.022a1.5 1.5 0 0 1 1.123-1.123l2.022-.46a.75.75 0 0 0 .594-.652c.05-.323.5-.668.5-1.088s-.45-.765-.5-1.088Z" />
    </template>

    <!-- CPU 图标 (Cpu chip) -->
    <template v-else-if="name === 'cpu'">
      <rect width="16" height="16" x="4" y="4" rx="2" />
      <rect width="6" height="6" x="9" y="9" rx="1" />
      <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 14h3M1 9h3M1 14h3" />
    </template>

    <!-- GPU 图标 (Gamepad / GPU) -->
    <template v-else-if="name === 'gpu'">
      <rect width="20" height="12" x="2" y="6" rx="2" />
      <path d="M6 12h4M8 10v4M15 11h.01M18 13h.01" />
    </template>

    <!-- 磁盘/存储 (Hard Drive / Disk) -->
    <template v-else-if="name === 'disk' || name === 'storage'">
      <rect width="20" height="8" x="2" y="12" rx="2" />
      <path d="M6 12V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8" />
      <circle cx="17" cy="16" r="1" />
    </template>

    <!-- 负载/趋势图 (Activity / Load) -->
    <template v-else-if="name === 'load' || name === 'activity'">
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </template>

    <!-- 统计/图表 (Bar chart) -->
    <template v-else-if="name === 'chart'">
      <line x1="18" x2="18" y1="20" y2="10" />
      <line x1="12" x2="12" y1="20" y2="4" />
      <line x1="6" x2="6" y1="20" y2="14" />
    </template>

    <!-- 网络/地球 (Globe) -->
    <template v-else-if="name === 'globe' || name === 'network'">
      <circle cx="12" cy="12" r="10" />
      <line x1="2" x2="22" y1="12" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </template>

    <!-- 速率/闪电 (Zap / Speed) -->
    <template v-else-if="name === 'speed' || name === 'zap'">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </template>
  </svg>
</template>

<script setup>
defineProps({
  name: {
    type: String,
    required: true
  },
  size: {
    type: [Number, String],
    default: 13
  },
  strokeWidth: {
    type: [Number, String],
    default: 2
  }
})
</script>

<style scoped>
.ui-icon {
  display: inline-block;
  vertical-align: -0.15em;
  flex-shrink: 0;
  stroke: currentColor;
}
</style>
