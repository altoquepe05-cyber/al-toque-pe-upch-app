(() => {
  'use strict';

  const DATABASE_NAME = 'al-toque-offline-data';
  const STORE_NAME = 'responses';
  let databasePromise;

  function openDatabase() {
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        if (!('indexedDB' in window)) {
          reject(new Error('IndexedDB no está disponible en este navegador.'));
          return;
        }

        const request = indexedDB.open(DATABASE_NAME, 1);
        request.onupgradeneeded = () => {
          if (!request.result.objectStoreNames.contains(STORE_NAME)) {
            request.result.createObjectStore(STORE_NAME, { keyPath: 'key' });
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error('No se pudo abrir IndexedDB.'));
        request.onblocked = () => reject(new Error('La base local de Al Toque está bloqueada.'));
      });
    }
    return databasePromise;
  }

  async function read(key) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(key);
      request.onsuccess = () => resolve(request.result ? request.result.value : null);
      request.onerror = () => reject(request.error || new Error('No se pudieron leer los datos locales.'));
    });
  }

  async function write(key, value) {
    const database = await openDatabase();
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put({ key, value, updatedAt: Date.now() });
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error || new Error('No se pudieron guardar los datos locales.'));
      transaction.onabort = () => reject(transaction.error || new Error('Se canceló el guardado local.'));
    });
  }

  async function staleWhileRevalidate(key, fetchValue) {
    let cached = null;
    try {
      cached = await read(key);
    } catch (error) {
      console.warn('No se pudo leer la caché local de Al Toque:', error);
    }

    const refresh = (async () => {
      const value = await fetchValue();
      try {
        await write(key, value);
      } catch (error) {
        console.warn('No se pudo guardar la respuesta en IndexedDB:', error);
      }
      return value;
    })();

    return { cached, refresh };
  }

  window.AlToqueOfflineData = Object.freeze({ staleWhileRevalidate });
})();
