// Durable Objects: 实时指标广播
// 显式 import + extends，确保 wrangler 静态分析器能在入口文件直接识别此 DO 类
import { MetricsBroadcaster as _MetricsBroadcaster } from './durable/MetricsBroadcaster.js';
import { ServerlessMonitorApp } from './app.js';

export class MetricsBroadcaster extends _MetricsBroadcaster {}
export { ServerlessMonitorApp };

export default {
  async fetch(request, env, ctx) {
    const app = new ServerlessMonitorApp(env, ctx);
    return app.fetch(request);
  },

  async scheduled(event, env, ctx) {
    const app = new ServerlessMonitorApp(env, ctx);
    return app.scheduled(event);
  }
};
