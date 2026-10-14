import { createApp } from 'vue';
import './style.css';
import './ui.css';

const artifact = new URL(location.href).searchParams.get('artifact');
if (artifact !== null) {
  const app = document.querySelector('#app');
  app.innerHTML = '<main style="max-width:32rem;margin:12vh auto;padding:1rem"><h1>正在打开产物</h1><p role="status">正在取得临时访问票据…</p></main>';
  import('./api.js')
    .then(({ openArtifactWithTicket }) => openArtifactWithTicket(artifact, { newTab: false }))
    .catch(error => {
      app.querySelector('[role="status"]').textContent = '打开失败：' + String(error?.message ?? error);
    });
} else {
  import('./Atlas.vue').then(({ default: Atlas }) => createApp(Atlas).mount('#app'));
}
