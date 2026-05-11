// functions/api/webhook.js

export default {
  async fetch(request, env, ctx) {
    // Only process POST requests (webhooks from Telegram)
    if (request.method !== "POST") {
      return new Response("Bot is active and listening for webhooks.", { status: 200 });
    }

    try {
      // Parse the incoming JSON payload from Telegram
      const update = await request.json();
      const token = env.TELEGRAM_TOKEN;

      // 1. Handle Callback Queries (When user clicks the Inline Keyboard buttons)
      if (update.callback_query) {
        const chatId = update.callback_query.message.chat.id;
        const type = update.callback_query.data; // 'income' or 'expense'

        // Retrieve pending transaction data from the session database
        const session = await env.DB.prepare(
          "SELECT temp_data FROM bot_sessions WHERE chat_id = ?"
        ).bind(chatId).first();

        if (session) {
          const data = JSON.parse(session.temp_data);
          
          // Insert the finalized transaction into the main database
          await env.DB.prepare(
            "INSERT INTO transactions (chat_id, amount, transaction_type, category, description) VALUES (?, ?, ?, ?, ?)"
          ).bind(chatId, data.amount, type, data.category, data.description).run();

          // Clear the session after successful insertion
          await env.DB.prepare("DELETE FROM bot_sessions WHERE chat_id = ?").bind(chatId).run();
          
          // Send success confirmation
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

        // Handle Text Commands
        if (update.message.text) {
          const text = update.message.text;
          
          if (text.startsWith("/start")) {
            const welcomeMessage = `Halo! Selamat datang di Bot Pencatat Keuangan Pintar. 💸\n\nCara menggunakannya sangat mudah:\n1. Kirimkan foto struk belanja, screenshot bukti transfer, atau tagihan.\n2. AI akan membaca nominal dan kategorinya secara otomatis.\n3. Konfirmasi apakah itu Pemasukan atau Pengeluaran.\n\nPerintah lain:\n👉 /report - Untuk melihat dashboard grafik dan export excel.\n\nYuk, coba kirimkan satu foto transaksimu sekarang!`;
            
            await sendMessage(chatId, welcomeMessage, token);
          } else if (text.startsWith("/report")) {
             // Generate dashboard URL dynamically
             const dashboardUrl = new URL(request.url).origin;
             await sendMessage(chatId, `📊 Cek laporan keuanganmu di sini:\n${dashboardUrl}/?chat_id=${chatId}`, token);
          } else {
            await sendMessage(chatId, "Kirimkan gambar/screenshot transaksi untuk mulai mencatat, atau ketik /report untuk melihat laporan.", token);
          }
        }

        // Handle Photos (Receipts)
        if (update.message.photo) {
           // Send a "processing" message first
           await sendMessage(chatId, "⏳ Sedang membaca struk...", token);

           // Get the highest resolution photo (the last element in the array)
           const fileId = update.message.photo[update.message.photo.length - 1].file_id;
           
           // Get file path from Telegram API
           const fileRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
           const fileData = await fileRes.json();
           const filePath = fileData.result.file_path;

           // Download the actual image
           const imgRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
           const imgBuffer = await imgRes.arrayBuffer();
           
           // Convert image buffer to Base64
           const base64Image = btoa(String.fromCharCode(...new Uint8Array(imgBuffer)));

           // Send the image to Gemini API
           const aiResult = await analyzeImage(base64Image, env.GEMINI_API_KEY);

           if (aiResult.error) {
             await sendMessage(chatId, "❌ Maaf, gambar ini tidak terbaca sebagai struk transaksi.", token);
             return new Response("OK", { status: 200 });
           }

           // Save temporary state to D1 database
           await env.DB.prepare(
              "INSERT OR REPLACE INTO bot_sessions (chat_id, temp_data, current_state) VALUES (?, ?, ?)"
           ).bind(chatId, JSON.stringify(aiResult), "waiting_type").run();

           // Ask user for transaction type using Inline Keyboard
           await sendInlineKeyboard(
             chatId, 
             `Data terbaca:\n💰 Nominal: Rp ${aiResult.amount.toLocaleString('id-ID')}\n🏷️ Kategori: ${aiResult.category}\n📝 Ket: ${aiResult.description}\n\nIni termasuk apa?`, 
             token
           );
        }
      }

      return new Response("OK", { status: 200 });
    } catch (error) {
      console.error("Webhook Error:", error);
      return new Response("Error processing request", { status: 500 });
    }
  }
};

// ==========================================
// HELPER FUNCTIONS
// ==========================================

// Function to send a basic text message via Telegram API
async function sendMessage(chatId, text, token) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text })
  });
}

// Function to send a message with inline buttons via Telegram API
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

// Function to call Gemini API and extract JSON data from image
async function analyzeImage(imageBase64, apiKey) {
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
  const textResponse = data.candidates[0].content.parts[0].text;
  
  // Clean up markdown tags if Gemini returns wrapped JSON
  const cleanJson = textResponse.replace(/```json|```/g, "").trim();
  return JSON.parse(cleanJson);
}
