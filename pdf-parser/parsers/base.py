import re
import pdfplumber
from pypdf import PdfReader
from pypdf.errors import PasswordError

class BaseParser:
    def __init__(self, file_path: str, password: str = None):
        self.file_path = file_path
        self.password = password
        self.pdf = None

    def open_pdf(self):
        try:
            # We open using pdfplumber, passing password if provided
            if self.password:
                self.pdf = pdfplumber.open(self.file_path, password=self.password)
            else:
                self.pdf = pdfplumber.open(self.file_path)
            return self.pdf
        except Exception as e:
            # Check if password exception
            if "password" in str(e).lower() or "decrypted" in str(e).lower():
                raise ValueError("PasswordRequired")
            raise e

    def close(self):
        if self.pdf:
            self.pdf.close()

    def clean_amount(self, amt_str: str) -> float:
        if not amt_str:
            return 0.0
        # Remove currency symbols and commas, and strip whitespace
        cleaned = re.sub(r'[^\d\.\-]', '', amt_str.replace(',', '').strip())
        try:
            return abs(float(cleaned))
        except ValueError:
            return 0.0

    def parse_date(self, date_str: str) -> str:
        # Standardize date format to YYYY-MM-DD
        if not date_str:
            return ""
        date_str = date_str.strip()
        match = re.search(r'(\d{4})[-\/\.]?(\d{2})[-\/\.]?(\d{2})', date_str)
        if match:
            return f"{match.group(1)}-{match.group(2)}-{match.group(3)}"
        return date_str

    def parse(self):
        raise NotImplementedError("Subclasses must implement parse()")
