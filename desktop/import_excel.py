import pandas as pd
import sqlite3
import os
import glob
import re

# Database path
db_path = 'C:/Users/ilyes/AppData/Roaming/desktop/pos-system.db'

def get_db_connection():
    return sqlite3.connect(db_path)

def generate_sku_barcode(name):
    clean_name = re.sub(r'[^a-zA-Z]', '', name)
    prefix = clean_name[:3].upper() if len(clean_name) >= 3 else name[:3].upper()
    # Adding a random flavor or numeric suffix to avoid unique constraint issues if needed, 
    # but the user said "just put the first three letters". 
    # Let's try pure prefix first.
    return prefix

def process_suppliers(supplier_val):
    if pd.isna(supplier_val):
        return []
    
    # Convert to string and handle potential numbers
    val_str = str(supplier_val).strip()
    
    # "skip the numbers in that field and only strings"
    # "you may find two strings in supplier field, that means those are two separate supplier"
    # Example: 'TAHAR/hchachena'
    
    # Split by common delimiters like '/' or ',' or '&'
    parts = re.split(r'[/,&]', val_str)
    
    clean_parts = []
    for p in parts:
        p = p.strip()
        # "skip the numbers" -> if it's just a number, skip it. 
        # But '825/tebicaouine' -> 825 is a number, tebicaouine is a string.
        # User said "skip the numbers in that field and only strings"
        
        # Check if part is primarily numeric
        if re.match(r'^\d+$', p):
            continue
            
        # Remove leading numbers/prefixes if present in a string part? 
        # e.g. "825 tebicaouine" -> "tebicaouine"? 
        # User said "skip the numbers ... and only strings"
        p_clean = re.sub(r'^\d+\s*', '', p).strip()
        
        if p_clean and len(p_clean) > 1:
            clean_parts.append(p_clean)
            
    return clean_parts

def sync_suppliers(conn, supplier_names):
    supplier_ids = []
    for name in supplier_names:
        cursor = conn.cursor()
        cursor.execute("SELECT id FROM suppliers WHERE company_name = ?", (name,))
        row = cursor.fetchone()
        if row:
            supplier_ids.append(row[0])
        else:
            cursor.execute("INSERT INTO suppliers (company_name) VALUES (?)", (name,))
            supplier_ids.append(cursor.lastrowid)
    return supplier_ids

def import_data():
    files = glob.glob('C:/Users/ilyes/Desktop/gestion/*.xlsx')
    conn = get_db_connection()
    
    # Get category mapping (Electricite/Plomberie)
    cursor = conn.cursor()
    cursor.execute("SELECT id, name FROM categories")
    categories = {row[1].lower(): row[0] for row in cursor.fetchall()}
    
    # Default category if not found
    default_cat_id = 1 # Electrical default
    
    for file in files:
        basename = os.path.basename(file).lower()
        if 'electricite' in basename:
            cat_id = categories.get('electrical', 1)
        elif 'plomberie' in basename:
            cat_id = categories.get('plumbing', 2)
        else:
            cat_id = default_cat_id
            
        print(f"\nImporting from: {file} (Category ID: {cat_id})")
        
        # Determine column structure based on file name
        # Electricite: Row 4 contains headers
        # Plomberie: Row 4 contains headers
        
        df = pd.read_excel(file, header=None)
        
        # Find the header row (look for 'DESIGNATION')
        header_row_idx = -1
        for i, row in df.iterrows():
            row_vals = [str(x).upper() for x in row.tolist()]
            if any('DESIGNATION' in str(v) for v in row_vals):
                header_row_idx = i
                break
        
        if header_row_idx == -1:
            print(f"Could not find header in {file}")
            continue
            
        # Extract headers and data
        headers = df.iloc[header_row_idx].tolist()
        data_df = df.iloc[header_row_idx+1:]
        data_df.columns = headers
        
        # Clean data_df: remove rows where name is NaN
        # Columns might be 'AAADesignation' or 'A/DESIGNATION'
        name_col = next((c for c in headers if isinstance(c, str) and 'DESIGNATION' in c.upper()), None)
        stock_col = next((c for c in headers if isinstance(c, str) and 'RESTE STOCK' in c.upper()), None)
        supplier_col = next((c for c in headers if isinstance(c, str) and 'FOURNISEUR' in c.upper()), None)
        
        if not name_col:
            print(f"Could not find Name column in {file}")
            continue
            
        for _, row in data_df.iterrows():
            name = str(row[name_col]).strip()
            if pd.isna(row[name_col]) or name == 'nan' or not name:
                continue
                
            qty_val = row[stock_col] if stock_col in row and not pd.isna(row[stock_col]) else 0
            # Handle special cases like '126+2T'
            if isinstance(qty_val, str):
                match = re.search(r'\d+', qty_val)
                qty_val = int(match.group()) if match else 0
            
            supplier_raw = row[supplier_col] if supplier_col in row else None
            supplier_names = process_suppliers(supplier_raw)
            supplier_ids = sync_suppliers(conn, supplier_names)
            
            # Use the first supplier ID for the main product link (Prisma/SQLite schema only supports one)
            primary_supplier_id = supplier_ids[0] if supplier_ids else None
            
            sku = generate_sku_barcode(name)
            barcode = sku
            
            # Check if product exists by name or SKU
            cursor.execute("SELECT id FROM products WHERE name = ? OR sku = ?", (name, sku))
            existing = cursor.fetchone()
            
            if existing:
                # Update stock
                product_id = existing[0]
                cursor.execute("UPDATE products SET category_id = ?, supplier_id = ? WHERE id = ?", 
                               (cat_id, primary_supplier_id, product_id))
                               
                # Update quantity in stock_inventory
                cursor.execute("UPDATE stock_inventory SET quantity = ? WHERE product_id = ?", (qty_val, product_id))
            else:
                # Insert new product
                try:
                    cursor.execute("""
                        INSERT INTO products (sku, barcode, name, category_id, supplier_id, is_active)
                        VALUES (?, ?, ?, ?, ?, 1)
                    """, (sku, barcode, name, cat_id, primary_supplier_id))
                    product_id = cursor.lastrowid
                    
                    # Insert initial stock
                    cursor.execute("""
                        INSERT INTO stock_inventory (product_id, quantity)
                        VALUES (?, ?)
                    """, (product_id, qty_val))
                except sqlite3.IntegrityError as e:
                    # In case SKU/Barcode prefix of 3 letters already exists, append a suffix
                    suffix = 1
                    new_sku = f"{sku}{suffix}"
                    while suffix < 100:
                        try:
                            cursor.execute("""
                                INSERT INTO products (sku, barcode, name, category_id, supplier_id, is_active)
                                VALUES (?, ?, ?, ?, ?, 1)
                            """, (new_sku, new_sku, name, cat_id, primary_supplier_id))
                            product_id = cursor.lastrowid
                            cursor.execute("INSERT INTO stock_inventory (product_id, quantity) VALUES (?, ?)", (product_id, qty_val))
                            break
                        except sqlite3.IntegrityError:
                            suffix += 1
                            new_sku = f"{sku}{suffix}"

        conn.commit()
    conn.close()
    print("\nImport completed successfully.")

if __name__ == "__main__":
    import_data()
