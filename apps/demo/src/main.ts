import { createApp } from 'vue';
import App from './App.vue';
import './styles.css';
// 副作用导入：注册配置表的热重载接收器（见 game/hmr.ts）。
// 必须在 App 之前导入，否则首次挂载时订阅的回调还没接上。
import './game/hmr';

createApp(App).mount('#app');
