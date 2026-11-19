[`paginate.js`](<workdir>/paginate.js:6) minimal biçimde düzeltildi; `test.js` değiştirilmedi.

Kök neden: Sayfa sayısı `Math.floor` ile eksik hesaplanıyor ve 1-tabanlı `page` değeri doğrudan başlangıç indeksi olarak kullanılıyordu. `Math.ceil` ve `(page - 1) * pageSize` bu iki sınır hatasını giderdi.

- Doğrulama: `node test.js` → `ok`; `node --check paginate.js` → başarılı.
- Kod incelemesi: Yerel incelemede bulgu yok.
- Güvenlik incelemesi: Yerel, mevcut-kaynak incelemesinde bulgu yok.