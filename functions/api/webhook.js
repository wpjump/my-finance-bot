// functions/api/webhook.js

export async function onRequestPost({ request, env }) {
  try {
    // Parse the incoming JSON payload from Telegram
    const update = await request.json();
    const token = env.TELEGRAM_TOKEN;

    // 1. Handle Callback Queries
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
        await sendMessage(chatId, `✅ Berhasil dicatat sebagai ${typeLabel}:\nRp ${data.amount.toLocaleString('id-ID')} (${data.category})`, token);
      } else {
         await sendMessage(chatId, "⚠️ Sesi sudah kadaluarsa atau data tidak ditemukan.", token);
      }
      return new Response("OK", { status: 200 });
    }

    // 2. Handle Standard Messages
    if (update.message) {
      const chatId = update.message.chat.id;

      if (update.message.text) {
        const text = update.message.text;
        
        if (text.startsWith("/start")) {
          const welcomeMessage = `Halo! Selamat datang di Bot Pencatat Keuangan Pintar. 💸\n\nCara menggunakannya sangat mudah:\n1. Kirimkan foto struk belanja, screenshot bukti transfer, atau tagihan.\n2. AI akan membaca nominal dan kategorinya secara otomatis.\n3. Konfirmasi apakah itu Pemasukan atau Pengeluaran.\n\nPerintah lain:\n👉 /report - Untuk melihat dashboard grafik dan export excel.\n\nYuk, coba kirimkan satu foto transaksimu sekarang!`;
          await sendMessage(chatId, welcomeMessage, token);
        } else if (text.startsWith("/report")) {
           const url = new URL(request.url);
           const dashboardUrl = `${url.protocol}//${url.hostname}`;
           await sendMessage(chatId, `📊 Cek laporan keuanganmu di sini:\n${dashboardUrl}/?chat_id=${chatId}`, token);
        } else {
          await sendMessage(chatId, "Kirimkan gambar/screenshot transaksi untuk mulai mencatat, atau ketik /report untuk melihat laporan.", token);
        }
      }

      if (update.message.photo) {
         await sendMessage(chatId, "⏳ Sedang membaca struk...", token);

         const fileId = update.message.photo[update.message.photo.length - 1].file_id;
         
         const fileRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
         const fileData = await fileRes.json();
         const filePath = fileData.result.file_path;

         const imgRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
         const imgBuffer = await imgRes.arrayBuffer();
         
         // [FIXED] Safely convert large image buffer to Base64
         const base64Image = arrayBufferToBase64(imgBuffer);

         const aiResult = await analyzeImage(base64Image, env.GEMINI_API_KEY);

         if (aiResult.error) {
           await sendMessage(chatId, "❌ Maaf, sistem gagal membaca gambar. Pastikan API Key benar dan gambar jelas.", token);
           return new Response("OK", { status: 200 });
         }

         await env.DB.prepare(
            "INSERT OR REPLACE INTO bot_sessions (chat_id, temp_data, current_state) VALUES (?, ?, ?)"
         ).bind(chatId, JSON.stringify(aiResult), "waiting_type").run();

         await sendInlineKeyboard(
           chatId, 
           `Data terbaca:\n💰 Nominal: Rp ${aiResult.amount.toLocaleString('id-ID')}\n🏷️ Kategori: ${aiResult.category}\n📝 Ket: ${aiResult.description}\n\nIni termasuk apa?`, 
           token
         );
      }
    }

    // Always return 200 to clear Telegram's queue
    return new Response("OK", { status: 200 });
  } catch (error) {
    console.error("Webhook Error:", error);
    // [FIXED] Force return 200 even on critical error to prevent Telegram retry loop spam
    return new Response("OK", { status: 200 });
  }
}

// ==========================================
// HELPER FUNCTIONS
// ==========================================

// Safe function to convert large ArrayBuffer to Base64 in Cloudflare Workers
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

async function analyzeImage(imageBase64, apiKey) {
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

    const payload = {
      contents: [{
        parts: [
          { text: "Analyze this receipt image. Extract data: amount (numbers only), category (one word), and a short description. Output strictly in raw JSON format like this: {\"amount\": 50000, \"category\": \"food\", \"description\": \"bought meatball\"}. If it is not a receipt/transaction, return {\"error\": \"not_transaction\"}" },
          {
            inline_data: {
              mime_type: "image/jpeg",
              data: imageBase64
            }
          }
        ]
      }]
    };

    const response = await fetch(url, {
      method: "POST",
      body: JSON.stringify(payload)
    });

    const data = await response.json();
    
    // Safety check if Gemini returns an error (e.g. invalid API key or content flagged)
    if (!data.candidates || data.candidates.length === 0) {
       console.error("Gemini API Error:", data);
       return { error: "api_failed" };
    }

    const textResponse = data.candidates[0].content.parts[0].text;
    const cleanJson = textResponse.replace(/```json|```/g, "").trim();
    return JSON.parse(cleanJson);
  } catch (e) {
    console.error("Parse Error:", e);
    return { error: "parse_failed" };
  }
}
