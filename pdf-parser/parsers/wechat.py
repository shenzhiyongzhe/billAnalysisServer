import re
from .base import BaseParser

class WechatParser(BaseParser):
    def parse(self):
        self.open_pdf()
        
        # 1. Parse summary from first page text
        first_page = self.pdf.pages[0]
        text = first_page.extract_text() or ""
        
        name = "未知"
        id_number = ""
        start_date = ""
        end_date = ""
        
        name_match = re.search(r'兹证明：(.*?)\（居民身份证：(.*?)\）', text)
        if name_match:
            name = name_match.group(1).strip()
            id_number = name_match.group(2).strip()
            
        date_range_match = re.search(r'起始时间：([\d\-\:\s]+)至([\d\-\:\s]+)', text)
        if date_range_match:
            start_date = self.parse_date(date_range_match.group(1))
            end_date = self.parse_date(date_range_match.group(2))
            
        transactions = []
        
        # 2. Extract tables page by page
        for page in self.pdf.pages:
            tables = page.extract_tables()
            for table in tables:
                for row in table:
                    # A valid WeChat transaction row must have 9 columns
                    if not row or len(row) < 9:
                        continue
                        
                    # Skip header row
                    if "交易时间" in str(row[0]):
                        continue
                        
                    # Clean fields
                    date_time = " ".join(str(row[0] or "").split()).strip() # replace newlines/tabs with space
                    
                    # Validate date_time format (should start with YYYY-MM-DD)
                    if not re.match(r'^\d{4}-\d{2}-\d{2}', date_time):
                        continue
                        
                    tx_type = " ".join(str(row[1] or "").split()).strip()
                    opponents = " ".join(str(row[2] or "").split()).strip()
                    product = " ".join(str(row[3] or "").split()).strip()
                    flow_col = " ".join(str(row[4] or "").split()).strip()
                    amount_str = str(row[5] or "").strip()
                    pay_method = " ".join(str(row[6] or "").split()).strip()
                    
                    # Parse amount
                    amount = self.clean_amount(amount_str)
                    
                    # Determine type (收入/支出/不计收支)
                    # flow_col values are usually "收入", "支出", "其他"
                    type_val = "支出"
                    if "其他" in flow_col:
                        type_val = "不计收支"
                    elif "收入" in flow_col:
                        type_val = "收入"
                    elif "支出" in flow_col:
                        type_val = "支出"
                    elif "不计" in flow_col:
                        type_val = "不计收支"
                        
                    # Reconstruct counterparty for "其他" type
                    if type_val == "不计收支" and ("其他" in flow_col or opponents == "/"):
                        # E.g. "零钱通转出-到零钱" or "信用卡还款-招商银行(1234)"
                        parts = []
                        if tx_type and tx_type != "/":
                            parts.append(tx_type)
                        if product and product != "/":
                            parts.append(product)
                        
                        if parts:
                            counterparty = "-".join(parts)
                        else:
                            counterparty = opponents if opponents != "/" else "微信支付"
                    else:
                        counterparty = opponents
                        if counterparty == "/" or not counterparty:
                            counterparty = product if (product and product != "/") else tx_type
                            
                    # Clean up double dashes or trailing slashes in counterparty
                    if counterparty:
                        counterparty = re.sub(r'-+$', '', counterparty)
                        counterparty = re.sub(r'^-+', '', counterparty)
                        counterparty = counterparty.strip()
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
                    
        # Sort chronologically, then reverse (descending order like original codebase)
        transactions.sort(key=lambda x: x["date"])
        
        if transactions and not start_date:
            start_date = transactions[0]["date"].split()[0]
        if transactions and not end_date:
            end_date = transactions[-1]["date"].split()[0]
            
        transactions.reverse()
        
        # Calculate summary metrics (will be calculated in NestJS anyway, but we output it)
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
