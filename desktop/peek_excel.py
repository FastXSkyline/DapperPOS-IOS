
import pandas as pd
import sys

def peek(file_path):
    print(f"Peeking {file_path}")
    try:
        df = pd.read_excel(file_path, header=None)
        print(df.head(20).to_string())
    except Exception as e:
        print(f"Error: {e}")

peek("C:/Users/ilyes/Desktop/gestion/FICHE.ELECTRICITE 2026.xlsx")
peek("C:/Users/ilyes/Desktop/gestion/FIHE PLOMBERIE 2026.xlsx")
