"""
SIF Safety Intelligence Platform - Database Module (SQLite / SQLAlchemy)
Designed for easy migration to PostgreSQL.
"""

import os
import sqlite3
from datetime import datetime
from typing import Optional, List, Dict, Any

raw_db_path = os.getenv("SQLITE_DB_PATH", "safety.db")
DB_PATH = os.path.abspath(raw_db_path)

def get_db_connection():
    """Create a connection to SQLite database."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn

def init_db():
    """Initialize database tables and indexes."""
    conn = get_db_connection()
    cursor = conn.cursor()

    # 1. Reports table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        file_size INTEGER DEFAULT 0,
        file_type TEXT DEFAULT 'txt',
        report_text TEXT NOT NULL,
        report_type TEXT DEFAULT 'unknown',
        location TEXT DEFAULT '',
        activity TEXT DEFAULT '',
        equipment TEXT DEFAULT '',
        date_reported TEXT DEFAULT '',
        uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        processing_status TEXT DEFAULT 'pending' -- pending, processing, completed, failed
    );
    """)

    # 2. Analysis table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS analysis (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_id INTEGER NOT NULL UNIQUE,
        sif_detected TEXT NOT NULL, -- YES, NO, REVIEW REQUIRED
        risk_score INTEGER NOT NULL, -- 0 to 100
        risk_level TEXT NOT NULL, -- CRITICAL, HIGH, MEDIUM, LOW
        priority_rank INTEGER DEFAULT 999,
        explanation TEXT NOT NULL,
        summary TEXT NOT NULL,
        worker_exposure INTEGER DEFAULT 0,
        missing_controls TEXT DEFAULT '',
        suggested_actions TEXT DEFAULT '',
        analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (report_id) REFERENCES reports (id) ON DELETE CASCADE
    );
    """)

    # 3. Factors table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS factors (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_id INTEGER NOT NULL,
        factor_type TEXT NOT NULL, -- hazard, unsafe_act, unsafe_condition, ppe_issue, missing_control, sif_indicator
        factor_name TEXT NOT NULL,
        evidence TEXT NOT NULL,
        FOREIGN KEY (report_id) REFERENCES reports (id) ON DELETE CASCADE
    );
    """)

    # 4. Reviews table (Human Review Log)
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_id INTEGER NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'Pending Review', -- Pending Review, Confirmed, Not a SIF Precursor, Requires Further Review
        reviewer TEXT DEFAULT 'Safety Officer',
        comment TEXT DEFAULT '',
        reviewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (report_id) REFERENCES reports (id) ON DELETE CASCADE
    );
    """)

    # 5. Background Jobs table
    cursor.execute("""
    CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        total_reports INTEGER DEFAULT 0,
        completed_reports INTEGER DEFAULT 0,
        failed_reports INTEGER DEFAULT 0,
        current_file TEXT DEFAULT '',
        current_step TEXT DEFAULT '',
        status TEXT DEFAULT 'running', -- running, completed, failed
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)

    # Indexes for high performance
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_reports_type ON reports (report_type);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_reports_status ON reports (processing_status);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_reports_uploaded ON reports (uploaded_at);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_analysis_risk ON analysis (risk_level);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_analysis_sif ON analysis (sif_detected);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_analysis_score ON analysis (risk_score);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_factors_report ON factors (report_id);")
    cursor.execute("CREATE INDEX IF NOT EXISTS idx_reviews_status ON reviews (status);")

    conn.commit()
    conn.close()

def reset_db():
    """Reset database tables and verify zero state."""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("BEGIN TRANSACTION;")
    cursor.execute("DELETE FROM reviews;")
    cursor.execute("DELETE FROM factors;")
    cursor.execute("DELETE FROM analysis;")
    cursor.execute("DELETE FROM reports;")
    cursor.execute("DELETE FROM jobs;")
    try:
        cursor.execute("DELETE FROM sqlite_sequence WHERE name IN ('reports', 'analysis', 'factors', 'reviews', 'jobs');")
    except Exception:
        pass
    cursor.execute("COMMIT;")

    tables = ["reports", "analysis", "factors", "reviews", "jobs"]
    counts = {}
    for t in tables:
        cursor.execute(f"SELECT COUNT(*) FROM {t}")
        count = cursor.fetchone()[0]
        counts[t] = count
        if count != 0:
            conn.close()
            raise RuntimeError(f"Reset failed: {t} still has {count} rows")
    conn.close()
    return counts

if __name__ == "__main__":
    init_db()
    print("Database initialized successfully.")
