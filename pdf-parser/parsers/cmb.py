import re
from .base import BaseParser

class CmbParser(BaseParser):
    def parse(self):
        self.open_pdf()
        
        # Extract text from all pages
        all_text = ""
        for page in self.pdf.pages:
            all_text += (page.extract_text() or "") + "\n"
            
        # Parse summary information
        name = "未知"
        card_number = ""
        start_date = ""
        end_date = ""
        
        name_match = re.search(r'户\s*名[：:]\s*([^\s\n]+)', all_text)
        if name_match:
            name = name_match.group(1).strip()
            
        card_match = re.search(r'账号[：:]\s*([\d*]+)', all_text)
        if card_match:
            card_number = card_match.group(1).strip()
            
        range_match = re.search(r'(\d{4}-\d{2}-\d{2})\s*--\s*(\d{4}-\d{2}-\d{2})', all_text)
        if range_match:
            start_date = range_match.group(1).strip()
            end_date = range_match.group(2).strip()
            
        # Process lines
        raw_lines = [l.strip() for l in all_text.split('\n') if l.strip()]
        
        def is_cmb_tx_line(line):
            return bool(re.match(r'^\d{4}-\d{2}-\d{2}\s+CNY\s+', line))
            
        def should_skip_cmb_noise(line):
            noise_keywords = [
                '记账日期', 'Transaction Statement', '招商银行交易流水',
                'Date Currency', 'Amount Balance', 'Transaction Type', 'Counter Party',
                '温馨提示', 'www.cmbchina', 'Verification Code', 'Account Type', 'Account No',
                'Sub Branch', 'Name', 'Date', 'Account '
            ]
            return (
                line.startswith('--') or 
                bool(re.match(r'^\d+/\d+$', line)) or
                any(kw in line for kw in noise_keywords)
            )
            
        merged_lines = []
        i = 0
        while i < len(raw_lines):
            line = raw_lines[i]
            if not is_cmb_tx_line(line):
                i += 1
                continue
                
            merged = line
            i += 1
            while i < len(raw_lines):
                next_line = raw_lines[i]
                if is_cmb_tx_line(next_line) or should_skip_cmb_noise(next_line):
                    break
                merged += " " + next_line
                i += 1
            merged_lines.append(merged)
            
        transactions = []
        row_re = r'^(\d{4}-\d{2}-\d{2})\s+CNY\s+(-?[0-9,]+\.[0-9]{2})\s+[0-9,]+\.[0-9]{2}\s+(.+)$'
        
        for line in merged_lines:
            match = re.match(row_re, line)
            if not match:
                continue
                
            date_time = match.group(1)
            amount_val = float(match.group(2).replace(',', ''))
            
            type_val = "支出" if amount_val < 0 else "收入"
            amount = abs(amount_val)
            
            remainder = match.group(3).strip()
            # Split remainder to extract counterparty
            # Usually: "快捷支付 微信转账" or "银联代付 支付宝（中国）"
            # We want to extract the counterparty (part after transaction type)
            parts = remainder.split()
            if len(parts) >= 2:
                # First token is transaction type (e.g. 银联快捷支付), the rest is counterparty
                counterparty = " ".join(parts[1:])
            else:
                counterparty = remainder
                
            if not counterparty:
                counterparty = "未知"
                
            date_only = date_time.split()[0]
            month = date_only[:7]
            
            transactions.append({
                "date": date_time,
                "month": month,
                "type": type_val,
                "amount": amount,
                "counterparty": counterparty
            })
            
        # Deduplicate transactions based on date, type, amount, counterparty
        seen = set()
        deduped_txs = []
        for tx in transactions:
            key = (tx["date"], tx["type"], tx["amount"], tx["counterparty"])
            if key not in seen:
                seen.add(key)
                deduped_txs.append(tx)
                
        # Sort chronologically, then reverse
        deduped_txs.sort(key=lambda x: x["date"])
        
        if deduped_txs and not start_date:
            start_date = deduped_txs[0]["date"]
        if deduped_txs and not end_date:
            end_date = deduped_txs[-1]["date"]
            
        deduped_txs.reverse()
        
        total_income = sum(t["amount"] for t in deduped_txs if t["type"] == "收入")
        total_expenditure = sum(t["amount"] for t in deduped_txs if t["type"] == "支出")
        
        self.close()
        
        return {
            "summary": {
                "id": "",
                "source": "招商银行",
                "name": name,
                "idNumber": "",
                "cardNumber": card_number,
                "startDate": start_date,
                "endDate": end_date,
                "totalIncome": round(total_income, 2),
                "totalExpenditure": round(total_expenditure, 2),
                "selfIncome": 0.0,
                "selfExpenditure": 0.0
            },
            "transactions": deduped_txs
        }
