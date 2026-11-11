import pandas as pd
import sys
import os
import re

diretorio_atual = os.path.dirname(os.path.abspath(__file__))
pasta_excel = os.path.join(diretorio_atual, "Planilhas Excel")
pasta_csv = os.path.join(diretorio_atual, "Planilhas CSV")

# 🔥 NOVO — limpeza pesada de caracteres invisíveis
def limpar_caracteres_invisiveis(texto):
    if pd.isna(texto) or texto == '':
        return ''
    
    texto = str(texto)

    # Remove zero-width chars e BOM
    texto = re.sub(r'[\u200B-\u200D\uFEFF]', '', texto)

    # Substitui NBSP por espaço normal
    texto = texto.replace('\xa0', ' ')

    # Remove caracteres de controle (exceto quebra já tratada)
    texto = re.sub(r'[\x00-\x1F\x7F]', ' ', texto)

    # Normaliza espaços
    texto = re.sub(r'\s+', ' ', texto)

    return texto.strip()


def formatar_nome(texto):
    if pd.isna(texto) or texto == '':
        return texto
        
    texto_formatado = limpar_caracteres_invisiveis(texto)

    texto_formatado = texto_formatado.replace(',', '.')
    texto_formatado = re.sub(r'[^\w\s\.:-]', ' ', texto_formatado)
    texto_formatado = re.sub(r'\s+', ' ', texto_formatado)

    return texto_formatado.strip().upper()


def formatar_valor(valor):
    if pd.isna(valor) or valor == '':
        return valor
    try:
        if isinstance(valor, str):
            valor = limpar_caracteres_invisiveis(valor)
            valor = valor.replace(',', '.')
        valor_float = float(valor)
        return str(valor_float).replace(',', '.')
    except ValueError:
        return valor


def formatar_corpo_texto(texto):
    if pd.isna(texto) or str(texto).strip() == '':
        return ''
        
    texto_formatado = limpar_caracteres_invisiveis(texto)

    texto_formatado = re.sub(r'(?i)\bnan\b', '', texto_formatado)

    # Remove quebras de linha
    texto_formatado = texto_formatado.replace('\r\n', ' ').replace('\n', ' ').replace('\r', ' ')

    # Remove aspas e vírgula
    texto_formatado = texto_formatado.replace(',', '.')
    texto_formatado = texto_formatado.replace('"', '')

    texto_formatado = re.sub(r'[^\w\s\.:-]', ' ', texto_formatado)
    texto_formatado = re.sub(r'\s+', ' ', texto_formatado)

    return texto_formatado.strip()


def processar_planilha(caminho_entrada, caminho_saida):
    print(f"Lendo o arquivo: {caminho_entrada}")
    
    try:
        df = pd.read_excel(caminho_entrada)

        # 🔥 LIMPEZA GLOBAL (ANTES DE QUALQUER COISA)
        for col in df.columns:
            df[col] = df[col].apply(limpar_caracteres_invisiveis)

        df = df.fillna('')

        renomear_colunas = {
            'Quantidade mínima': 'Quantidade Mínima',
            'Identificador (Sistema)': 'Identificador do Sistema'
        }
        df = df.rename(columns=renomear_colunas)
        
        print(f"Colunas encontradas: {df.columns.tolist()}")

        if 'Descrição' in df.columns:
            df['Descrição'] = df['Descrição'].apply(formatar_nome)
            print("[OK] Descricao formatada")

        if 'Valor' in df.columns:
            df['Valor'] = df['Valor'].apply(formatar_valor)
            print("[OK] Valor formatado")
        
        # 🔥 MESCLAGEM SEGURA
        if 'Conteúdo do Produto/Embalagem' in df.columns and 'Observações (colar o texto no final da célula a esquerda)' in df.columns:
            df['Conteúdo do Produto/Embalagem'] = df.apply(
                lambda row: formatar_corpo_texto(
                    limpar_caracteres_invisiveis(
                        str(row.get('Conteúdo do Produto/Embalagem', '')) + ' ' + 
                        str(row.get('Observações (colar o texto no final da célula a esquerda)', ''))
                    )
                ),
                axis=1
            )
            
            df = df.drop(columns=['Observações (colar o texto no final da célula a esquerda)'])
            print("[OK] Conteudo mesclado com Observacoes")
        elif 'Conteúdo do Produto/Embalagem' in df.columns:
            df['Conteúdo do Produto/Embalagem'] = df['Conteúdo do Produto/Embalagem'].apply(formatar_corpo_texto)
            print("[OK] Conteudo formatado")

        ordem_colunas = [
            'Descrição',
            'Código',
            'Categoria',
            'Tipo de Unidade',
            'Fator de Conversão',
            'Unidade de Entrada',
            'Valor',
            'Estoque',
            'Quantidade Mínima',
            'Conteúdo do Produto/Embalagem',
            'Identificador do Sistema'
        ]
        
        colunas_existentes = [col for col in ordem_colunas if col in df.columns]
        colunas_extras = [col for col in df.columns if col not in ordem_colunas]

        df = df[colunas_existentes + colunas_extras]
        print("[OK] Colunas reorganizadas")

        for col in df.columns:
            df[col] = df[col].astype(str).str.replace(',', '.', regex=False)

        df.to_csv(caminho_saida, index=False, sep=',', decimal='.', encoding='utf-8-sig')


        with open(caminho_saida, 'rb+') as f:
            f.seek(0, 2)  
            tamanho = f.tell()
            f.seek(max(tamanho - 2, 0))
            final = f.read(2)
            if final == b'\r\n':
                f.seek(-2, 2)

                f.truncate()
        print(f"\n[SUCESSO] Arquivo salvo em: {caminho_saida}")
        print(f"Total de linhas processadas: {len(df)}")
        print(f"\nColunas finais: {df.columns.tolist()}")
        
    except Exception as e:
        print(f"[ERRO] Erro ao processar o arquivo: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    if len(sys.argv) == 3:
        arquivo_entrada = sys.argv[1] if os.path.isabs(sys.argv[1]) else os.path.join(pasta_excel, sys.argv[1])
        arquivo_saida = sys.argv[2] if os.path.isabs(sys.argv[2]) else os.path.join(pasta_csv, sys.argv[2])
    else:
        arquivo_entrada = os.path.join(pasta_excel, "Planilha Modelo.xlsx")  
        arquivo_saida = os.path.join(pasta_csv, "planilha_modificada.csv")
        
        print("=" * 80)
        print("PROCESSADOR DE PLANILHAS")
        print("=" * 80)
        print("\nUso recomendado no terminal:")
        print("  python processar_planilha.py <entrada.xlsx> <saida.csv>")
        print(f"\nUsando valores padrão: {arquivo_entrada} -> {arquivo_saida}\n")
        print("=" * 80 + "\n")

    if os.path.exists(arquivo_entrada):
        processar_planilha(arquivo_entrada, arquivo_saida)
    else:
        print(f"[ERRO] O arquivo de entrada '{arquivo_entrada}' nao foi encontrado.")