export function createChartUpdateScheduler() {
  const pending = new Set()
  let frame = null
  return {
    schedule(chart) {
      if (!chart) return
      pending.add(chart)
      if (frame !== null) return
      frame = requestAnimationFrame(() => {
        frame = null
        for (const item of pending) {
          if (item.ctx) item.update('none')
        }
        pending.clear()
      })
    },
    cancel() {
      if (frame !== null) cancelAnimationFrame(frame)
      frame = null
      pending.clear()
    }
  }
}
