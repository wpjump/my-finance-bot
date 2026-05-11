CREATE TABLE transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER,
    amount REAL,
    transaction_type TEXT,
    category TEXT,
    description TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE bot_sessions (
    chat_id INTEGER PRIMARY KEY,
    temp_data TEXT,
    current_state TEXT
);
