// public/js/app.js
const urlParams = new URLSearchParams(window.location.search);
const chatId = urlParams.get('chat_id');
let transactionData = [];

async function fetchData() {
    if (!chatId) return alert("Buka link ini melalui bot Telegram Anda!");
    
    const res = await fetch(`/api/data?chat_id=${chatId}`);
    transactionData = await res.json();
    
    renderCharts();
    renderTable();
}

function renderCharts() {
    const categories = {};
    let income = 0, expense = 0;

    transactionData.forEach(t => {
        // Hitung per tipe
        if (t.transaction_type === 'income') income += t.amount;
        else expense += t.amount;

        // Hitung per kategori
        categories[t.category] = (categories[t.category] || 0) + t.amount;
    });

    // Chart Tipe (Donut)
    new Chart(document.getElementById('chartType'), {
        type: 'doughnut',
        data: {
            labels: ['Pemasukan', 'Pengeluaran'],
            datasets: [{ data: [income, expense], backgroundColor: ['#10B981', '#EF4444'] }]
        }
    });

    // Chart Kategori (Bar)
    new Chart(document.getElementById('chartCategory'), {
        type: 'bar',
        data: {
            labels: Object.keys(categories),
            datasets: [{ label: 'Total Nominal', data: Object.values(categories), backgroundColor: '#3B82F6' }]
        }
    });
}

function renderTable() {
    const body = document.getElementById('tableBody');
    body.innerHTML = transactionData.map(t => `
        <tr class="border-b">
            <td class="px-5 py-4 text-sm">${new Date(t.created_at).toLocaleDateString()}</td>
            <td class="px-5 py-4 text-sm capitalize">${t.category}</td>
            <td class="px-5 py-4 text-sm">
                <span class="px-2 py-1 rounded ${t.transaction_type === 'income' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}">
                    ${t.transaction_type}
                </span>
            </td>
            <td class="px-5 py-4 text-sm text-right font-bold">Rp ${t.amount.toLocaleString()}</td>
        </tr>
    `).join('');
}

function exportToExcel() {
    const ws = XLSX.utils.json_to_sheet(transactionData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Transactions");
    XLSX.writeFile(wb, "Finance_Report.xlsx");
}

fetchData();
