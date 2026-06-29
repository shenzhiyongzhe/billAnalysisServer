import re
from .base import BaseParser

class AlipayParser(BaseParser):
    def parse(self):
        self.open_pdf()
        
        # 1. Parse summary from first page text
        first_page = self.pdf.pages[0]
        text = first_page.extract_text() or ""
        
        name = "未知"
        id_number = ""
        start_date = ""
        end_date = ""
        
        name_match = re.search(r'兹证明:(.*?)\(证件号码:(.*?)\)', text)
        if name_match:
            name = name_match.group(1).strip()
            id_number = name_match.group(2).strip()
            
        transactions = []
        
        # Extract text from all pages to parse transactions
        all_text = ""
        for page in self.pdf.pages:
            all_text += (page.extract_text() or "") + "\n"
            
        # Extract date range if present
        date_range_match = re.search(r'查询交易起止时间：([\d\-\:\s]+)至([\d\-\:\s]+)', all_text)
        if date_range_match:
            start_date = self.parse_date(date_range_match.group(1))
            end_date = self.parse_date(date_range_match.group(2))

        # Direct line-based parsing (fast and matches original JS logic)
        lines = [l.strip() for l in all_text.split('\n') if l.strip()]
        txs = []
        current_tx = []
        
        for line in lines:
            if line.startswith('支出 ') or line.startswith('收入 ') or line == '不计' or line.startswith('不计 '):
                if current_tx:
                    txs.append(current_tx)
                current_tx = [line]
            else:
                if current_tx:
                    current_tx.append(line)
        if current_tx:
            txs.append(current_tx)
            
        for tx_lines in txs:
            full_text = " ".join(tx_lines)
            type_match = re.match(r'^(支出|收入|不计\s*收支)', full_text)
            if not type_match:
                continue
                
            type_str = type_match.group(1).replace(" ", "")
            type_val = "不计收支" if "不计" in type_str else type_str
            
            amount_match = re.search(r'\s([0-9]+\.[0-9]{2})\s', full_text)
            if not amount_match:
                continue
            amount = float(amount_match.group(1))
            
            date_match = re.search(r'(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}:\d{2}))?', full_text)
            if not date_match:
                continue
                
            date_time = f"{date_match.group(1)} {date_match.group(2)}" if date_match.group(2) else date_match.group(1)
            date_only = date_match.group(1)
            month = date_only[:7]
            
            # Extract counterparty: text after type, up to the first space
            remaining = full_text[type_match.end():].strip()
            counterparty = remaining.split()[0] if remaining else "支付宝商户"
            if counterparty == "/":
                counterparty = "支付宝商户"
                
            transactions.append({
                "date": date_time,
                "month": month,
                "type": type_val,
                "amount": amount,
                "counterparty": counterparty
            })
                
        # Sort chronologically, then reverse
        transactions.sort(key=lambda x: x["date"])
        
        if transactions and not start_date:
            start_date = transactions[0]["date"].split()[0]
        if transactions and not end_date:
            end_date = transactions[-1]["date"].split()[0]
            
        transactions.reverse()
        
        total_income = sum(t["amount"] for t in transactions if t["type"] == "收入")
        total_expenditure = sum(t["amount"] for t in transactions if t["type"] == "支出")
        
        self.close()
        
        return {
            "summary": {
                "id": "",
                "source": "支付宝",
                "name": name,
                "idNumber": id_number,
                "cardNumber": "",
                "startDate": start_date,
                "endDate": end_date,
                "totalIncome": round(total_income, 2),
                "totalExpenditure": round(total_expenditure, 2),
                "selfIncome": 0.0,
                "selfExpenditure": 0.0
            },
            "transactions": transactions
        }
