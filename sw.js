self.addEventListener('push', e => {
  const data = e.data ? e.data.json() : { title: '克克', body: '有消息' };
  e.waitUntil(
    self.registration.showNotification(data.title || '克克', {
      body: data.body || '',
      icon: data.icon || '/icons/icon-180.png',
      badge: '/icons/icon-180.png',
      tag: 'kk-msg',
      renotify: true,
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes(self.location.origin) && 'focus' in c) return c.focus();
      }
      return clients.openWindow('/');
    })
  );
});
