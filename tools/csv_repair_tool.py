import pandas as pd
import sys
import os
import re

diretorio_atual = os.path.dirname(os.path.abspath(__file__))
pasta_excel = os.path.join(diretorio_atual, "Repair Tool")

def is_float(s):
    try:
        float(s.replace(',', '.'))
        return True
    except ValueError:
        return False

def is_int(s):
    try:
        int(s)
        return True
    except ValueError:
        return False

def is_valid_identifier(s):
    """Verifica se a string não quebrou (sem espaços)."""
    s = s.strip()
    if not s:
        return False
    
    # PROTEÇÃO 1: Um identificador do sistema real geralmente tem pelo menos 15 caracteres.
    # O "5cm" passava por ter letras e números. Vamos exigir um tamanho mínimo de 10 caracteres
    # para evitar falsos positivos de medidas.
    if len(s) < 10:
        return False
        
    return bool(re.match(r'^[A-Za-z0-9\-\_]+$', s))

def csv_repair_tool(input_csv, output_xlsx):
    print("="*80)
    print("[REPARANDO] REPARANDO CSV - LOGICA DA ANCORA (COM LOOKAHEAD)")
    print("="*80)
    
    with open(input_csv, 'r', encoding='utf-8-sig') as f:
        lines = f.readlines()
        
    # Fixar as colunas EXATAMENTE como na Planilha Modelo
    header_cols = [
        'Descrição', 'Código', 'Categoria', 'Tipo de Unidade',
        'Fator de Conversão', 'Unidade de Entrada', 'Valor', 'Estoque',
        'Quantidade Mínima', 'Conteúdo do Produto/Embalagem',
        'Observações (colar o texto no final da célula a esquerda)',
        'Identificador do Sistema'
    ]
    
    data_lines = lines[1:]
    
    fixed_rows = []
    buffer = ""
    
    # Precisamos iterar com índice para poder "olhar para a próxima linha" (lookahead)
    for index in range(len(data_lines)):
        line_raw = data_lines[index].strip('\n').strip('\r')
        
        # Ignora quebras vazias, mas mantém se o buffer já existir
        if not line_raw and not buffer:
            continue
            
        # Se a linha quebrou, da um merge
        if buffer:
            buffer += " " + line_raw
        else:
            buffer = line_raw
            
        parts = [p.strip() for p in buffer.split(',')]
        
        anchor_idx = -1
        
        for i in range(len(parts)):
            if parts[i].lower() in ['s', 'n']:
                if i >= 6 and i + 1 < len(parts):
                    # i-1: Valor (float) | i-3: Fator de Conversão | i+1: Qtd Mínima
                    if is_float(parts[i-1]) and is_int(parts[i-3]) and is_int(parts[i+1]):
                        anchor_idx = i
                        break
        
        if anchor_idx != -1:
            last_term = parts[-1]
            
            # PROTEÇÃO 2 (Lookahead): Se existe uma próxima linha, e ela é um "órfão"
            # (começa com vírgula ou não tem estrutura suficiente pra ser uma linha inteira),
            # nós IGNORAMOS a validação e obrigamos o buffer a continuar.
            forca_continuar = False
            if index + 1 < len(data_lines):
                proxima_linha = data_lines[index + 1].strip('\n').strip('\r')
                if proxima_linha:
                    # Se a próxima linha começa com vírgula
                    if proxima_linha.startswith(','):
                        forca_continuar = True
                    # Se a próxima linha tem poucas colunas
                    elif len(proxima_linha.split(',')) < 8:
                        forca_continuar = True
            
            if is_valid_identifier(last_term) and not forca_continuar:
                # 3. fatiar e dar merge nas colunas de texto quebradas.
                codigo = parts[anchor_idx-6]
                categoria = parts[anchor_idx-5]
                tipo_unidade = parts[anchor_idx-4]
                fator_conv = parts[anchor_idx-3]
                unid_entrada = parts[anchor_idx-2]
                valor = parts[anchor_idx-1]
                estoque = parts[anchor_idx]
                qtd_min = parts[anchor_idx+1]
                identificador = parts[-1]
                
                descricao = ', '.join(parts[:anchor_idx-6])
                conteudo = ', '.join(parts[anchor_idx+2:-1])
                
                fixed_rows.append([
                    descricao, codigo, categoria, tipo_unidade, fator_conv,
                    unid_entrada, valor, estoque, qtd_min, conteudo, "", identificador
                ])
                
                buffer = ""
            else:
                # O identificador é inválido (ex: "5cm") ou foi forçado a continuar pela linha debaixo
                pass
        else:
            pass
            
    df = pd.DataFrame(fixed_rows, columns=header_cols)
    
    for col in df.columns:
        if df[col].dtype == 'object':
            df[col] = df[col].astype(str).str.strip()
            
    df.to_excel(output_xlsx, index=False)
    
    print(f"\n[SUCESSO] Total de produtos recuperados: {len(fixed_rows)}")
    print(f"[OK] Salvo em: {output_xlsx}")
    return df

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Uso: python csv_repair_tool.py <quebrado.csv> <consertado.xlsx>")
        sys.exit(1)
        
    if len(sys.argv) == 3:
        arquivo_entrada = sys.argv[1] if os.path.isabs(sys.argv[1]) else os.path.join(pasta_excel, sys.argv[1])
        arquivo_saida = sys.argv[2] if os.path.isabs(sys.argv[2]) else os.path.join(pasta_excel, sys.argv[2])
            
        csv_repair_tool(arquivo_entrada, arquivo_saida)
