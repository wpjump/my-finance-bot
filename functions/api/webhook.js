// functions/api/webhook.js

export async function onRequestPost({ request, env }) {
  try {
    const update = await request.json();
    const token = env.TELEGRAM_TOKEN;
    const ownerId = String(env.OWNER_CHAT_ID); // Get the owner's ID from Cloudflare settings

    // --- SECURITY CHECK: GET CURRENT CHAT ID ---
    let currentChatId = null;
    if (update.message) {
      currentChatId = String(update.message.chat.id);
    } else if (update.callback_query) {
      currentChatId = String(update.callback_query.message.chat.id);
    }

    // --- AUTHORIZATION GATE ---
    // If we have a chat ID, but it doesn't match the owner, reject it!
    if (currentChatId && currentChatId !== ownerId) {
       console.warn(`Unauthorized access attempt from Chat ID: ${currentChatId}`);
       // Optional: Send a rejection message to the intruder
       await sendMessage(currentChatId, "⛔ Maaf, bot ini adalah asisten pribadi dan dikunci hanya untuk pemiliknya.", token);
       
       // Return 200 OK so Telegram doesn't retry the message
       return new Response("Unauthorized", { status: 200 }); 
    }

    // ==========================================
    // 1. Handle Callback Queries (From Inline Keyboard Buttons)
    // ==========================================
    if (update.callback_query) {
      const chatId = update.callback_query.message.chat.id;
      const type = update.callback_query.data; 

      const session = await env.DB.prepare(
        "SELECT temp_data FROM bot_sessions WHERE chat_id = ?"
      ).bind(chatId).first();

      if (session) {
        const data = JSON.parse(session.temp_data);
        
        await env.DB.prepare(
          "INSERT INTO transactions (chat_id, amount, transaction_type, category, description) VALUES (?, ?, ?, ?, ?)"
        ).bind(chatId, data.amount, type, data.category, data.description).run();

        await env.DB.prepare("DELETE FROM bot_sessions WHERE chat_id = ?").bind(chatId).run();
        
        const typeLabel = type === 'income' ? 'Pemasukan 📈' : 'Pengeluaran 📉';
        await sendMessage(chatId, `✅ Berhasil dicatat sebagai ${typeLabel}:\nRp ${data.amount.toLocaleString('id-ID')} (${data.category})\nKet: ${data.description}`, token);
      } else {
         await sendMessage(chatId, "⚠️ Sesi sudah kadaluarsa atau data tidak ditemukan.", token);
      }
      return new Response("OK", { status: 200 });
    }

    // ==========================================
    // 2. Handle Messages (Text, Photos, or Text + Photos)
    // ==========================================
    if (update.message) {
      const chatId = update.message.chat.id;
      const text = update.message.text || update.message.caption || "";

      if (text.startsWith("/start")) {
        const welcomeMessage = `Halo Boss! Saya AI Asisten Keuangan Pribadimu. 💸\n\nApa yang bisa saya lakukan?\n1. Catat via Teks: "Catat pengeluaran 45rb buat beli kopi"\n2. Catat via Gambar: Kirim foto struk/bukti transfer.\n3. Tanya Keuangan: "Berapa kurs dollar hari ini?" atau "Gimana cara nabung buat KPR?"\n\n👉 /report - Lihat grafik laporan keuanganmu.`;
        await sendMessage(chatId, welcomeMessage, token);
        return new Response("OK", { status: 200 });
      } 
      
      if (text.startsWith("/report")) {
         const url = new URL(request.url);
         const dashboardUrl = `${url.protocol}//${url.hostname}`;
         await sendMessage(chatId, `📊 Cek laporan keuanganmu di sini:\n${dashboardUrl}/?chat_id=${chatId}`, token);
         return new Response("OK", { status: 200 });
      }

      if (text || update.message.photo) {
         await sendMessage(chatId, "⏳ Memproses...", token);
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

         const aiResult = await askGeminiAgent(text, base64Image, env.GEMINI_API_KEY);

         if (aiResult.type === "chat") {
             await sendMessage(chatId, aiResult.reply, token);
         } 
         else if (aiResult.type === "transaction") {
             if (aiResult.transaction_type === "expense" || aiResult.transaction_type === "income") {
                 await env.DB.prepare(
                    "INSERT INTO transactions (chat_id, amount, transaction_type, category, description) VALUES (?, ?, ?, ?, ?)"
                 ).bind(chatId, aiResult.amount, aiResult.transaction_type, aiResult.category, aiResult.description).run();

                 const typeLabel = aiResult.transaction_type === 'income' ? 'Pemasukan 📈' : 'Pengeluaran 📉';
                 await sendMessage(chatId, `✅ Berhasil dicatat otomatis sebagai ${typeLabel}:\nRp ${aiResult.amount.toLocaleString('id-ID')} (${aiResult.category})\nKet: ${aiResult.description}`, token);
             } 
             else {
                 await env.DB.prepare(
                    "INSERT OR REPLACE INTO bot_sessions (chat_id, temp_data, current_state) VALUES (?, ?, ?)"
                 ).bind(chatId, JSON.stringify(aiResult), "waiting_type").run();

                 await sendInlineKeyboard(
                   chatId, 
                   `Data transaksi terbaca:\n💰 Nominal: Rp ${aiResult.amount.toLocaleString('id-ID')}\n🏷️ Kategori: ${aiResult.category}\n📝 Ket: ${aiResult.description}\n\nIni termasuk jenis apa?`, 
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
          { text: "Pemasukan 📈", callback_data: "income" },
          { text: "Pengeluaran 📉", callback_data: "expense" }
        ]]
      }
    })
  });
}

// New Gemini Agent Logic
async function askGeminiAgent(textInput, imageBase64, apiKey) {
  try {
    // Upgraded to newer model endpoint
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

    const prompt = `Kamu adalah asisten keuangan pribadi bernama "MyFinance AI". 
    Tugasmu MENGANALISIS input user (teks atau gambar) dan membalas HANYA dengan format JSON yang valid. Jangan gunakan markdown.
    
    ATURAN LOGIKA:
    1. JIKA input berisi perintah mencatat uang/transaksi/struk, buat JSON:
       {"type": "transaction", "amount": angka_saja, "category": "satu_kata", "transaction_type": "expense/income/unknown", "description": "keterangan singkat"}
       *Catatan transaction_type: Jika user secara eksplisit bilang pengeluaran/beli/bayar gunakan "expense". Jika gaji/dapat/terima gunakan "income". Jika dari gambar struk tidak ketahuan itu uang masuk atau keluar, gunakan "unknown".
    
    2. JIKA input adalah pertanyaan wajar seputar keuangan (kurs, investasi, tips hemat, pajak), buat JSON:
       {"type": "chat", "reply": "jawaban edukatif dan ramah dari kamu"}
    
    3. JIKA input DI LUAR topik keuangan (misal: minta buat gambar, resep makanan, coding, lelucon), TOLAK dengan sopan:
       {"type": "chat", "reply": "Maaf, saya didesain khusus sebagai asisten keuangan. Saya tidak bisa membantu terkait topik tersebut."}

    INPUT USER: "${textInput || "Analisis gambar struk ini."}"`;

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
       return { type: "chat", reply: "Maaf, sistem AI tidak dapat merespon saat ini. Pastikan gambar jelas atau server sedang tidak sibuk." };
    }

    const textResponse = data.candidates[0].content.parts[0].text;
    const cleanJson = textResponse.replace(/```json|```/g, "").trim();
    
    // Safety parse just in case Gemini accidentally adds conversational text
    return JSON.parse(cleanJson);
  } catch (e) {
    console.error("Gemini Agent Error:", e);
    return { type: "chat", reply: "Terjadi kesalahan internal saat AI membaca datamu." };
  }
}
