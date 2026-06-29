import re
from .base import BaseParser

class WechatParser(BaseParser):
    def is_wechat_merchant_id(self, val: str) -> bool:
        return val == '/' or (len(val) >= 10 and bool(re.match(r'^[0-9a-zA-Z_\-]+$', val)))

    def extract_wechat_counterparty(self, same_line: str, next_lines: list) -> str:
        parts = []
        if same_line:
            tokens = same_line.split()
            for token in tokens:
                if token and self.is_wechat_merchant_id(token):
                    break
                if token:
                    parts.append(token)
                    
        for line in next_lines:
            line = line.strip()
            if not line:
                continue
            if line == '/':
                break
            if self.is_wechat_merchant_id(line):
                break
            if line.startswith('--') or line.startswith('说明'):
                break
            parts.append(line)
            
        return "".join(parts).strip() or "未知"

    def parse(self):
        self.open_pdf()
        
        # Extract text from all pages
        all_text = ""
        for page in self.pdf.pages:
            all_text += (page.extract_text() or "") + "\n"
            
        # Parse summary from text
        name = "未知"
        id_number = ""
        start_date = ""
        end_date = ""
        
        name_match = re.search(r'兹证明：(.*?)\（居民身份证：(.*?)\）', all_text)
        if name_match:
            name = name_match.group(1).strip()
            id_number = name_match.group(2).strip()
            
        date_range_match = re.search(r'起始时间：([\d\-\:\s]+)至([\d\-\:\s]+)', all_text)
        if date_range_match:
            start_date = self.parse_date(date_range_match.group(1))
            end_date = self.parse_date(date_range_match.group(2))
            
        transactions = []
        lines = [l.strip() for l in all_text.split('\n') if l.strip()]
        
        i = 0
        while i < len(lines):
            # Check if line contains date format YYYY-MM-DD
            date_match = re.search(r'(\d{4}-\d{2}-\d{2})', lines[i])
            if date_match:
                date_str = date_match.group(1)
                month = date_str[:7]
                
                # Check for time in current line or next line
                time_match = re.search(r'(\d{2}:\d{2}:\d{2})', lines[i])
                block_start = i + 1
                if not time_match and i + 1 < len(lines):
                    time_match = re.search(r'(\d{2}:\d{2}:\d{2})', lines[i+1])
                    if time_match:
                        block_start = i + 2
                        
                time_str = time_match.group(1) if time_match else "00:00:00"
                date_time = f"{date_str} {time_str}"
                
                # Collect block lines until next date or page marker
                block_lines = [lines[i]]
                j = block_start
                while j < len(lines):
                    if j > i + 1 and re.search(r'(\d{4}-\d{2}-\d{2})', lines[j]):
                        break
                    if lines[j].startswith("--- PAGE") or "微信支付交易明细证明" in lines[j] or "具体交易明细" in lines[j]:
                        break
                    block_lines.append(lines[j])
                    j += 1
                    
                amount_line = block_lines[0]
                amount_match = re.search(r'(\d+\.\d{2})', amount_line)
                if amount_match:
                    amount = float(amount_match.group(1))
                    block_text = " ".join(block_lines)
                    is_other_type = "其他" in amount_line or "其他" in block_text
                    
                    type_val = "支出"
                    if is_other_type:
                        type_val = "不计收支"
                    elif "收入" in block_text:
                        type_val = "收入"
                    elif "支出" in block_text:
                        type_val = "支出"
                    elif "不计" in block_text:
                        type_val = "不计收支"
                        
                    # Extract counterparty tokens
                    tokens = []
                    for line in block_lines:
                        # Remove date and time to clean tokens
                        line_clean = re.sub(r'\d{2}:\d{2}:\d{2}', '', line)
                        line_clean = re.sub(r'\d{4}-\d{2}-\d{2}', '', line_clean)
                        tokens.extend(line_clean.split())
                        
                    keywords = {
                        "二维码收款", "转账", "商户消费", "扫二维码付", "转入零钱通-", "零钱通转出-",
                        "收入", "支出", "其他", "零钱", "零钱通", "银行卡", "来自零钱", "到零钱",
                        "元", "币种：人民币", "单位：元", "/", "商户", "分付"
                    }
                    
                    counterparty_parts = []
                    for t in tokens:
                        if t == amount_match.group(1):
                            continue
                        if t in keywords or any(kw in t for kw in ["时间", "方式", "金额", "交易单", "商户单"]):
                            continue
                        if self.is_wechat_merchant_id(t) or t.isdigit():
                            continue
                        counterparty_parts.append(t)
                        
                    counterparty = "".join(counterparty_parts).strip()
                    counterparty = re.sub(r'[\/\\()（）]+$', '', counterparty)
                    
                    # Special cases for transfers
                    detail_match = re.search(r'(零钱通转出-\s*到零钱|转入零钱通-\s*来自零钱|零钱提现-\s*到银行卡|分付还款-\s*到分付|零钱充值-\s*来自银行卡)', block_text.replace(" ", ""))
                    if detail_match:
                        counterparty = detail_match.group(1)
                    elif is_other_type:
                        # For other types, try to match common patterns or fallback
                        alt_match = re.search(r'(零钱通转出-|转入零钱通-|零钱提现|分付还款|零钱充值)', block_text.replace(" ", ""))
                        if alt_match:
                            counterparty = alt_match.group(1)
                        if not counterparty or counterparty == "/":
                            counterparty = "其他交易"
                            
                    if not counterparty or counterparty == "/":
                        counterparty = "/"
                        
                    transactions.append({
                        "date": date_time,
                        "month": month,
                        "type": type_val,
                        "amount": amount,
                        "counterparty": counterparty
                    })
                i = j
            else:
                i += 1
                
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
                "source": "微信",
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
