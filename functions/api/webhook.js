export async function onRequestPost({ request, env }) {
  try {
    const update = await request.json();
    const token = env.TELEGRAM_TOKEN;
    const ownerId = env.OWNER_CHAT_ID ? String(env.OWNER_CHAT_ID) : null; 
    // Ambil nama bos dari variabel, kalau kosong panggil "Bos"
    const ownerName = env.OWNER_NAME ? env.OWNER_NAME : "Bos"; 

    // --- SECURITY CHECK: GET CURRENT CHAT ID ---
    let currentChatId = null;
    if (update.message) {
      currentChatId = String(update.message.chat.id);
    } else if (update.callback_query) {
      currentChatId = String(update.callback_query.message.chat.id);
    }

    // --- SETUP & AUTHORIZATION GATE ---
    // 1. Jika OWNER_CHAT_ID belum disetting di Cloudflare
    if (!ownerId || ownerId === 'xxx') {
      const setupMsg = `Halo! 👋 Aku sistem AI yang baru di-deploy.\n\nBiar aman dan nggak bisa dibajak orang lain, kamu harus nge-klaim aku sebagai milikmu.\n\n🔑 **Chat ID kamu:** \`${currentChatId}\`\n\n**Cara Klaim (Hanya 1 Menit):**\n1. Copy Chat ID kamu di atas.\n2. Buka dashboard Cloudflare > Project kamu > Settings > Environment variables.\n3. Buat/Edit variable \`OWNER_CHAT_ID\` dan paste angka tadi.\n4. (Opsional) Buat variable \`OWNER_NAME\` dan isi namamu (misal: "Mas Wid").\n5. Save, lalu tekan tombol **Retry deployment**.\n\nKalau udah, ketik /start lagi ya!`;
      
      await sendMessage(currentChatId, setupMsg, token);
      return new Response("OK", { status: 200 }); 
    }
    
    // 2. Jika yang chat BUKAN pemilik bot
    if (currentChatId && currentChatId !== ownerId) {
       console.warn(`Unauthorized access attempt from Chat ID: ${currentChatId}`);
       await sendMessage(currentChatId, "Waduh, maaf ya! ⛔ Aku ini asisten pribadi majikanku. Kamu gak punya akses buat nyuruh-nyuruh aku, hehe.", token);
       return new Response("OK", { status: 200 }); 
    }

    // ==========================================
    // 1. Handle Callback Queries (Tombol Pemasukan/Pengeluaran)
    // ==========================================
    if (update.callback_query) {
      const chatId = update.callback_query.message.chat.id;
      const type = update.callback_query.data; 

      const session = await env.DB.prepare(
        "SELECT temp_data FROM bot_sessions WHERE chat_id = ?"
      ).bind(chatId).first();

      if (session) {
        const data = JSON.parse(session.temp_data);
        const dateToInsert = data.date || getFallbackDate();
        
        await env.DB.prepare(
          "INSERT INTO transactions (chat_id, amount, transaction_type, category, description, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(chatId, data.amount, type, data.category, data.description, dateToInsert).run();

        await env.DB.prepare("DELETE FROM bot_sessions WHERE chat_id = ?").bind(chatId).run();
        
        const typeLabel = type === 'income' ? 'Uang Masuk 📈' : 'Pengeluaran 📉';
        await sendMessage(chatId, `✅ Siap ${ownerName}! Udah aku catet sebagai ${typeLabel}:\nRp ${data.amount.toLocaleString('id-ID')} (${data.category})\nKet: ${data.description}\n📅 Waktu: ${dateToInsert}`, token);
      } else {
         await sendMessage(chatId, `Hmm, data transaksi ini kayaknya udah kadaluarsa atau ilang nih ${ownerName}. Ulangi lagi ya.`, token);
      }
      return new Response("OK", { status: 200 });
    }

    // ==========================================
    // 2. Handle Messages (Teks, Foto, atau Teks + Foto)
    // ==========================================
    if (update.message) {
      const chatId = update.message.chat.id;
      const text = update.message.text || update.message.caption || "";

      if (text.startsWith("/start")) {
        const welcomeMessage = `Halo ${ownerName}! 🙌 Aku udah aktif dan siap bantu ngurusin keuanganmu.\n\nCaranya gampang banget:\n✍️ **Ketik manual:** "Tadi abis beli bakso 25rb" atau "Dapet gajian bulan ini 5 juta".\n📸 **Kirim foto:** Kirim foto struk/bukti transfer. Bisa dikasih caption juga, misal "Beli kopi kemarin sore".\n🧠 **Tanya-tanya:** "Berapa kurs dollar hari ini?" atau "Gimana cara mulai nabung reksadana?"\n\nCek laporan lengkap dan grafikmu di sini:\n👉 /report\n\nYuk, cobain catet pengeluaran pertamamu ${ownerName}!`;
        await sendMessage(chatId, welcomeMessage, token);
        return new Response("OK", { status: 200 });
      } 
      
      if (text.startsWith("/report")) {
         const url = new URL(request.url);
         const dashboardUrl = `${url.protocol}//${url.hostname}`;
         await sendMessage(chatId, `📊 Ini link laporan keuangannya ${ownerName}:\n${dashboardUrl}/?chat_id=${chatId}`, token);
         return new Response("OK", { status: 200 });
      }

      if (text || update.message.photo) {
         await sendMessage(chatId, `⏳ Bentar ${ownerName}, lagi aku cek...`, token);
         let base64Image = null;

         if (update.message.photo) {
             const fileId = update.message.photo[update.message.photo.length - 1].file_id;
             const fileRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
             const fileData = await fileRes.json();
             const filePath = fileData.result.file_path;

             const imgRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
             const imgBuffer = await imgRes.arrayBuffer();
             base64Image = arrayBufferToBase64(imgBuffer);
         }

         const aiResult = await askGeminiAgent(text, base64Image, env.GEMINI_API_KEY, ownerName);

         if (aiResult.type === "chat") {
             await sendMessage(chatId, aiResult.reply, token);
         } 
         else if (aiResult.type === "transaction") {
             const dateToInsert = aiResult.date || getFallbackDate();

             if (aiResult.transaction_type === "expense" || aiResult.transaction_type === "income") {
                 // Gemini 100% yakin ini pengeluaran/pemasukan (biasanya karena ada caption/teks)
                 await env.DB.prepare(
                    "INSERT INTO transactions (chat_id, amount, transaction_type, category, description, created_at) VALUES (?, ?, ?, ?, ?, ?)"
                 ).bind(chatId, aiResult.amount, aiResult.transaction_type, aiResult.category, aiResult.description, dateToInsert).run();

                 const typeLabel = aiResult.transaction_type === 'income' ? 'Uang Masuk 📈' : 'Pengeluaran 📉';
                 await sendMessage(chatId, `✅ Beres bos! Otomatis dicatet sebagai ${typeLabel}:\nRp ${aiResult.amount.toLocaleString('id-ID')} (${aiResult.category})\nKet: ${aiResult.description}\n📅 ${dateToInsert}`, token);
             } 
             else {
                 // Gambar struk tanpa caption yang jelas, tanyakan ke user
                 await env.DB.prepare(
                    "INSERT OR REPLACE INTO bot_sessions (chat_id, temp_data, current_state) VALUES (?, ?, ?)"
                 ).bind(chatId, JSON.stringify({...aiResult, date: dateToInsert}), "waiting_type").run();

                 await sendInlineKeyboard(
                   chatId, 
                   `Ketemu nih transaksinya:\n💰 Nominal: Rp ${aiResult.amount.toLocaleString('id-ID')}\n🏷️ Kategori: ${aiResult.category}\n📝 Ket: ${aiResult.description}\n📅 ${dateToInsert}\n\nKalo boleh tau, ini uang masuk atau keluar bos?`, 
                   token
                 );
             }
         }
      }
    }

    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("Webhook Error:", error);
    return new Response("OK", { status: 200 });
  }
}

// ==========================================
// HELPER FUNCTIONS
// ==========================================

function getFallbackDate() {
  // Menghasilkan tanggal default dengan format YYYY-MM-DD HH:MM:SS (UTC, nanti disesuaikan via JS di frontend jika perlu)
  return new Date().toISOString().replace('T', ' ').substring(0, 19);
}

function arrayBufferToBase64(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function sendMessage(chatId, text, token) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text })
  });
}

async function sendInlineKeyboard(chatId, text, token) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      reply_markup: {
        inline_keyboard: [[
          { text: "Uang Masuk 📈", callback_data: "income" },
          { text: "Pengeluaran 📉", callback_data: "expense" }
        ]]
      }
    })
  });
}

// Gemini Agent Logic
async function askGeminiAgent(textInput, imageBase64, apiKey, ownerName) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
    
    // Inject waktu saat ini agar Gemini tahu konteks "Kemarin" atau "Hari ini"
    const currentDate = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', dateStyle: 'full', timeStyle: 'long' });

    const prompt = `Kamu adalah asisten keuangan pribadi yang santai, asik, friendly, dan pinter bernama "MyFinance AI". Kamu harus memanggil saya sebagai "${ownerName}".
    Saat ini di Indonesia adalah: ${currentDate}.
    Tugasmu MENGANALISIS input user (teks/caption atau gambar) dan membalas HANYA dengan format JSON yang valid tanpa markdown.
    
    ATURAN LOGIKA:
    1. JIKA input berisi perintah mencatat uang (contoh: "beli bakso kemarin 15rb", "gajian 5 juta", atau gambar struk belanja):
       Buat JSON:
       {"type": "transaction", "amount": angka_saja, "category": "satu_kata_kategori", "transaction_type": "expense/income/unknown", "description": "keterangan singkat", "date": "YYYY-MM-DD HH:MM:SS"}
       *Catatan transaction_type: Jika ada teks yang secara eksplisit berarti pengeluaran/beli/bayar, gunakan "expense". Jika gaji/dapat/terima, gunakan "income". Jika input HANYA berupa gambar struk TANPA caption yang jelas, WAJIB gunakan "unknown".
       *Catatan date: Pahami konteks waktu user (misal "kemarin", "tadi pagi", "tanggal 5"). Hitung mundur/maju berdasarkan waktu saat ini (${currentDate}). Jika tidak ada keterangan, gunakan format waktu saat ini (YYYY-MM-DD HH:MM:SS).
    
    2. JIKA input pertanyaan wajar seputar keuangan (kurs, investasi, tips hemat):
       Buat JSON: {"type": "chat", "reply": "jawaban asik, edukatif, dan ramah menggunakan bahasa sehari-hari (pakai sebutan aku/kamu atau bos)"}
    
    3. JIKA input DI LUAR topik keuangan (misal minta code, resep, dll):
       Buat JSON: {"type": "chat", "reply": "Waduh ${ownerName}, aku cuma asisten keuangan nih. Kalo urusan di luar duit aku kurang paham, hehe. Ada transaksi yang mau dicatat?"}

    INPUT USER: "${textInput || "Tolong analisis gambar struk ini."}"`;

    const parts = [{ text: prompt }];

    if (imageBase64) {
      parts.push({
        inline_data: { mime_type: "image/jpeg", data: imageBase64 }
      });
    }

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: parts }] })
    });

    const data = await response.json();
    
    if (!data.candidates || data.candidates.length === 0) {
       return { type: "chat", reply: `Waduh, AI-nya lagi pusing nih ${ownerName}. Coba kirim gambarnya yang lebih jelas atau ketik manual aja ya.` };
    }

    const textResponse = data.candidates[0].content.parts[0].text;
    const cleanJson = textResponse.replace(/```json|```/g, "").trim();
    
    return JSON.parse(cleanJson);
  } catch (e) {
    console.error("Gemini Agent Error:", e);
    return { type: "chat", reply: `Oops, ada error internal pas baca datamu ${ownerName}. Coba lagi bentar ya.` };
  }
}
