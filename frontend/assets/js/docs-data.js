// Endpoint documentation data for docs.html. Kept in a separate file so the
// curl examples (which contain literal backslash-newline line continuations)
// stay easy to read and edit.

const FreeGwDocs = (() => {
  function nativeEndpoints(baseUrl, key) {
    return [
      {
        method: "POST",
        path: "/api/v1/messages/send",
        title: "Kirim pesan",
        desc: "Mendukung tipe text, image, document, video.",
        curl:
          "curl -X POST " + baseUrl + "/api/v1/messages/send \\\n" +
          '  -H "Authorization: Bearer ' + key + '" \\\n' +
          '  -H "Content-Type: application/json" \\\n' +
          "  -d '{\n" +
          '    "instance_id": "<device-id-dari-halaman-Perangkat>",\n' +
          '    "recipient": "6281234567890",\n' +
          '    "type": "text",\n' +
          '    "content": { "text": "Halo dari sistem!" }\n' +
          "  }'",
        response:
          "{\n" +
          '  "success": true,\n' +
          '  "message": "Message successfully accepted into the routing queue.",\n' +
          '  "data": { "job_id": "123", "message_id": "uuid...", "status": "QUEUE" }\n' +
          "}",
      },
      {
        method: "GET",
        path: "/api/v1/messages/logs",
        title: "Riwayat pesan",
        desc: "Filter opsional: device_id, status, type, recipient, start, end, page, limit.",
        curl:
          'curl -X GET "' + baseUrl + '/api/v1/messages/logs?status=FAILED&limit=20" \\\n' +
          '  -H "Authorization: Bearer ' + key + '"',
      },
      {
        method: "POST",
        path: "/api/v1/messages/logs/:id/resend",
        title: "Kirim ulang pesan gagal",
        desc: "Hanya berlaku untuk pesan berstatus FAILED.",
        curl:
          "curl -X POST " + baseUrl + "/api/v1/messages/logs/<message_id>/resend \\\n" +
          '  -H "Authorization: Bearer ' + key + '"',
      },
      {
        method: "GET",
        path: "/api/v1/devices",
        title: "Daftar perangkat",
        desc: "Lihat semua instance WhatsApp beserta status koneksinya.",
        curl:
          "curl -X GET " + baseUrl + "/api/v1/devices \\\n" +
          '  -H "Authorization: Bearer ' + key + '"',
      },
      {
        method: "POST",
        path: "/api/v1/auth/keys/:id/webhook",
        title: "Pasang webhook",
        desc: "Method PUT. Event: message.received, message.sent/delivered/read/failed, instance.status_changed, instance.disconnected.",
        curl:
          "curl -X PUT " + baseUrl + "/api/v1/auth/keys/<key_id>/webhook \\\n" +
          '  -H "Authorization: Bearer ' + key + '" \\\n' +
          '  -H "Content-Type: application/json" \\\n' +
          "  -d '{\"webhook_url\":\"https://endpoint-anda.com/webhook\"}'",
      },
    ];
  }

  function legacyEndpoints(baseUrl, key) {
    return [
      {
        method: "GET",
        path: "/status",
        title: "Cek status koneksi",
        desc: "Status device yang aktif (default device / device tunggal).",
        curl:
          "curl -X GET " + baseUrl + "/status \\\n" +
          '  -H "x-api-key: ' + key + '"',
        response:
          '{ "success": true, "status": "connected",\n' +
          '  "device": { "phone": "628xx", "name": "Nama WA", "platform": "multi-device" },\n' +
          '  "uptime": 3600 }',
      },
      {
        method: "POST",
        path: "/send-message",
        title: "Kirim pesan teks",
        desc: "Field: number, message.",
        curl:
          "curl -X POST " + baseUrl + "/send-message \\\n" +
          '  -H "Content-Type: application/json" \\\n' +
          '  -H "x-api-key: ' + key + '" \\\n' +
          "  -d '{\"number\":\"628123456789\",\"message\":\"Halo dari sistem!\"}'",
      },
      {
        method: "POST",
        path: "/send-button",
        title: "Pesan dengan opsi",
        desc: "Otomatis dikirim sebagai teks bernomor (WA modern tak dukung tombol asli).",
        curl:
          "curl -X POST " + baseUrl + "/send-button \\\n" +
          '  -H "Content-Type: application/json" \\\n' +
          '  -H "x-api-key: ' + key + '" \\\n' +
          "  -d '{\"number\":\"628123456789\",\"message\":\"Konfirmasi:\",\"buttons\":[\"Ya\",\"Batal\"]}'",
      },
      {
        method: "POST",
        path: "/send-media",
        title: "Kirim file dari URL",
        desc: "Field: number, url, caption. Tipe file dideteksi otomatis dari ekstensi.",
        curl:
          "curl -X POST " + baseUrl + "/send-media \\\n" +
          '  -H "Content-Type: application/json" \\\n' +
          '  -H "x-api-key: ' + key + '" \\\n' +
          "  -d '{\"number\":\"628123456789\",\"url\":\"https://example.com/file.pdf\",\"caption\":\"Dokumen\"}'",
      },
      {
        method: "POST",
        path: "/send-bulk",
        title: "Kirim pesan massal",
        desc: "Jeda antar-pesan otomatis diatur FREE GW (2-5 detik acak per perangkat).",
        curl:
          "curl -X POST " + baseUrl + "/send-bulk \\\n" +
          '  -H "Content-Type: application/json" \\\n' +
          '  -H "x-api-key: ' + key + '" \\\n' +
          "  -d '{\"data\":[{\"number\":\"628123\",\"msg\":\"Halo A!\"},{\"number\":\"628124\",\"msg\":\"Halo B!\"}]}'",
      },
      {
        method: "POST",
        path: "/validate-number",
        title: "Validasi nomor WA",
        desc: "Cek apakah nomor terdaftar di WhatsApp.",
        curl:
          "curl -X POST " + baseUrl + "/validate-number \\\n" +
          '  -H "Content-Type: application/json" \\\n' +
          '  -H "x-api-key: ' + key + '" \\\n' +
          "  -d '{\"number\":\"628123456789\"}'",
        response: '{ "success": true, "exists": true, "jid": "628xx@s.whatsapp.net" }',
      },
      {
        method: "GET",
        path: "/groups",
        title: "Daftar grup",
        desc: "Semua grup yang diikuti oleh perangkat.",
        curl:
          "curl -X GET " + baseUrl + "/groups \\\n" +
          '  -H "x-api-key: ' + key + '"',
      },
      {
        method: "POST",
        path: "/set-webhook",
        title: "Pasang webhook",
        desc: "Field: url.",
        curl:
          "curl -X POST " + baseUrl + "/set-webhook \\\n" +
          '  -H "Content-Type: application/json" \\\n' +
          '  -H "x-api-key: ' + key + '" \\\n' +
          "  -d '{\"url\":\"https://endpoint-anda.com/webhook\"}'",
      },
      {
        method: "POST",
        path: "/send-file",
        title: "Upload & kirim file",
        desc: "multipart/form-data. Field: number, caption, file. Maks 25 MB.",
        curl:
          "curl -X POST " + baseUrl + "/send-file \\\n" +
          '  -H "x-api-key: ' + key + '" \\\n' +
          '  -F "number=628123456789" \\\n' +
          '  -F "caption=Laporan bulan ini" \\\n' +
          '  -F "file=@/path/ke/file.pdf"',
      },
      {
        method: "POST",
        path: "/send-base64",
        title: "Kirim file base64",
        desc: 'Field: number, base64, mimetype, fileName. Sertakan "fileName" kalau ingin nama file yang tampil di WhatsApp sesuai (mis. "Sertifikat_Nama.pdf") — kalau tidak dikirim, FREE GW cuma bisa menebak ekstensi dari mimetype (jadi tampil "dokumen.pdf" generik, bukan nama aslinya).',
        curl:
          "curl -X POST " + baseUrl + "/send-base64 \\\n" +
          '  -H "Content-Type: application/json" \\\n' +
          '  -H "x-api-key: ' + key + '" \\\n' +
          "  -d '{\"number\":\"628123456789\",\"base64\":\"JVBERi0xLjQ...\",\"mimetype\":\"application/pdf\",\"fileName\":\"Sertifikat_Nama.pdf\"}'",
      },
      {
        method: "POST",
        path: "/device/reset",
        title: "Logout perangkat",
        desc: "Reset koneksi perangkat secara remote - perlu pindai ulang QR setelahnya.",
        curl:
          "curl -X POST " + baseUrl + "/device/reset \\\n" +
          '  -H "x-api-key: ' + key + '"',
      },
    ];
  }

  return { nativeEndpoints, legacyEndpoints };
})();
