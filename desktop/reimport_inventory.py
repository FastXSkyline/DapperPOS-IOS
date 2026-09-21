import pandas as pd
import sqlite3
import os
import glob
import re

# Database path
db_path = 'C:/Users/ilyes/AppData/Roaming/desktop/pos-system.db'

# Normalization Mapping (Fixing Typos)
NORMALIZATION_MAP = {
    # Typos
    r'\bAPLIQUE\b': 'APPLIQUE',
    r'\bAVABO\b': 'LAVABO',
    r'\bDESTRIBUTEUR\b': 'DISTRIBUTEUR',
    r'\bMELTIGEUR\b': 'MITIGEUR',
    r'\bMETIGEUR\b': 'MITIGEUR',
    r'\bMONCHON\b': 'MANCHON',
    r'\bPERGEUR\b': 'PURGEUR',
    r'\bPOLISTERELLE\b': 'POLYSTYRENE',
    r'\bRABAUTEUSE\b': 'RABOTEUSE',
    r'\bTIFLAN\b': 'TEFLON',
    r'\bVIDENGEUR\b': 'VIDANGEUR',
    r'\bEVILLE\b': 'EVIER',
    r'\bEVILE\b': 'EVIER',
    r'\bFLIXIBLE\b': 'FLEXIBLE',
    r'\bIMPERMIABLE\b': 'IMPERMEABLE',
    r'\bLACHOUSSE\b': 'LA HOUSSE',
    r'\bMEMELON\b': 'MAMELON',
    r'\bPIKEUR\b': 'PIQUEUR',
    r'\bVISSE\b': 'VIS',
    r'\bSERTIE\b': 'SERTI',
    r'\bGAZE\b': 'GAZ',
    r'\bALUM\b': 'ALUMINIUM',
    r'\bENGLAISE\b': 'ANGLAISE',
}

def clean_name(name):
    if not isinstance(name, str):
        return ""
    name = name.upper().strip()
    # Replace multiple spaces
    name = re.sub(r'\s+', ' ', name)
    # Apply normalization map
    for pattern, replacement in NORMALIZATION_MAP.items():
        name = re.sub(pattern, replacement, name, flags=re.IGNORECASE)
    return name

def get_category(name, file_cat):
    name_upper = name.upper()
    
    # Safety Equipment (ID 4)
    safety_keywords = ['GANT', 'CASQUE', 'CHAUSSURE', 'LUNETTE', 'MASQUE', 'PROTECTION', 'HARNAIS', 'COMBINAISON', 'GILET', 'SÉCURITÉ']
    if any(k in name_upper for k in safety_keywords):
        return 4 
        
    # Consumables (ID 5)
    consumable_keywords = ['COLLE', 'SCOTCH', 'RUBAN', 'PILE', 'AMPOULE', 'FUSIBLE', 'TEFLON', 'JOINT', 'VIS ', ' BOULON', 'CHEVILLE', 'SILICONE', 'MOUSSE', 'DISQUE', 'POINTE', 'CLOU', 'TIFLAN', 'WD-40', 'GRAISSE']
    if any(k in name_upper for k in consumable_keywords):
        return 5
        
    return file_cat

def import_inventory():
    print("Starting FINAL inventory re-import...")
    
    # 1. Connect and Reset
    try:
        conn = sqlite3.connect(db_path)
        cursor = conn.cursor()
        
        print("Resetting current products and stock...")
        tables_to_clear = [
            "stock_movements", "stock_inventory", "transaction_items", 
            "transactions", "purchase_order_items", "purchase_orders", 
            "products", "product_variants"
        ]
        for table in tables_to_clear:
            try:
                cursor.execute(f"DELETE FROM {table}")
            except:
                pass
        conn.commit()
    except Exception as e:
        print(f"Error resetting database: {e}")
        return

    # 2. Find Files
    files = glob.glob('C:/Users/ilyes/Desktop/gestion/*.xlsx')
    
    total_count = 0
    for file in files:
        basename = os.path.basename(file).upper()
        print(f"\nProcessing: {os.path.basename(file)}")
        
        # Initial Category based on file
        file_cat = 1 # Default Electrical
        if 'PLOMBERIE' in basename:
            file_cat = 2 # Plumbing
            
        try:
            df = pd.read_excel(file, header=None)
        except Exception as e:
            print(f"Error reading {file}: {e}")
            continue
            
        # Find Header Row
        header_idx = -1
        for i, row in df.iterrows():
            row_str = [str(val).upper() for val in row]
            if any('DESIGNATION' in s for s in row_str):
                header_idx = i
                break
        
        if header_idx == -1:
            continue
            
        headers = df.iloc[header_idx].tolist()
        data_df = df.iloc[header_idx+1:]
        
        # Identify columns
        name_col = -1
        stock_col = -1
        for i, h in enumerate(headers):
            h_str = str(h).upper()
            if 'DESIGNATION' in h_str: name_col = i
            if 'RESTE STOCK' in h_str: stock_col = i
            
        if name_col == -1:
            continue
            
        file_count = 0
        for _, row in data_df.iterrows():
            raw_name = row[name_col]
            if pd.isna(raw_name) or str(raw_name).strip() == "" or str(raw_name).lower() == 'nan':
                continue
                
            name = clean_name(str(raw_name))
            if not name: continue
            
            qty = 0
            if stock_col != -1 and stock_col < len(row):
                raw_qty = row[stock_col]
                if not pd.isna(raw_qty):
                    if isinstance(raw_qty, (int, float, complex)):
                        qty = float(raw_qty.real if hasattr(raw_qty, 'real') else raw_qty)
                    else:
                        match = re.search(r'-?[\d\.,]+', str(raw_qty))
                        if match:
                            qty = float(match.group().replace(',', '.'))

            cat_id = get_category(name, file_cat)
            
            # Generate Unique SKU
            clean_sku = re.sub(r'[^A-Z0-9]', '', name)[:10]
            sku = f"{clean_sku}{total_count}"
            
            try:
                cursor.execute("""
                    INSERT INTO products (name, sku, barcode, category_id, is_active, cost_price, retail_price)
                    VALUES (?, ?, ?, ?, 1, 0, 0)
                """, (name, sku, sku, cat_id))
                prod_id = cursor.lastrowid
                
                cursor.execute("INSERT INTO stock_inventory (product_id, quantity) VALUES (?, ?)", (prod_id, qty))
                file_count += 1
                total_count += 1
            except Exception as e:
                # print(f"Error inserting {name}: {e}")
                pass

        print(f"Imported {file_count} products.")
        conn.commit()

    conn.close()
    print(f"\nSUCCESS: Imported total of {total_count} products correctly categorized.")

if __name__ == "__main__":
    import_inventory()
