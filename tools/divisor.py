import csv
import sys
import os

diretorio_atual = os.path.dirname(os.path.abspath(__file__))
pasta_csv = os.path.join(diretorio_atual, "Planilhas CSV")

def dividir_csv(caminho_entrada, linhas_por_arquivo=100):
    print(f"Lendo o arquivo: {caminho_entrada}")

    try:
        with open(caminho_entrada, 'r', newline='', encoding='utf-8') as f:
            reader = list(csv.reader(f))

        total_linhas = len(reader)

        if total_linhas == 0:
            print("[AVISO] O arquivo esta vazio. Nada a dividir.")
            return

        cabecalho = reader[0]
        dados = reader[1:]

        print(f"Total de linhas (sem cabeçalho): {len(dados)}")

        if len(dados) == 0:
            print("[AVISO] O arquivo so contem cabecalho.")
            return

        nome_base = os.path.splitext(os.path.basename(caminho_entrada))[0]
        total_arquivos = 0

        for i in range(0, len(dados), linhas_por_arquivo):
            bloco_dados = dados[i:i + linhas_por_arquivo]
            numero_arquivo = (i // linhas_por_arquivo) + 1

            nome_saida = f"{nome_base}_parte_{numero_arquivo}.csv"
            caminho_saida = os.path.join(pasta_csv, nome_saida)

            with open(caminho_saida, 'w', newline='', encoding='utf-8') as f_out:
                writer = csv.writer(f_out)
                
                # escreve cabeçalho + dados
                writer.writerow(cabecalho)
                writer.writerows(bloco_dados)

            print(f"[OK] Arquivo criado: {caminho_saida} ({len(bloco_dados)} linhas + cabecalho)")
            total_arquivos += 1

        print("\n" + "=" * 60)
        print("[SUCESSO] PROCESSO FINALIZADO COM SUCESSO")
        print(f"Total de arquivos gerados: {total_arquivos}")
        print("=" * 60)

    except Exception as e:
        print(f"[ERRO] Erro ao processar o arquivo: {e}")
        import traceback
        traceback.print_exc()


if __name__ == "__main__":
    if len(sys.argv) >= 2:
        arquivo_entrada = sys.argv[1] if os.path.isabs(sys.argv[1]) else os.path.join(pasta_csv, sys.argv[1])
        
        # Se passar o número de linhas, usa ele; senão, padrão = 100
        if len(sys.argv) >= 3:
            try:
                linhas = int(sys.argv[2])
            except ValueError:
                print("[ERRO] o numero de linhas deve ser um inteiro.")
                sys.exit(1)
        else:
            linhas = 100
    else:
        arquivo_entrada = os.path.join(pasta_csv, "arquivo.csv")
        linhas = 100

        print("=" * 80)
        print("DIVISOR DE CSV")
        print("=" * 80)
        print("\nUso recomendado no terminal:")
        print("  python divisor.py <arquivo.csv> <linhas_por_arquivo>")
        print(f"\nUsando padrão: {linhas} linhas por arquivo\n")
        print("=" * 80 + "\n")

    if os.path.exists(arquivo_entrada):
        dividir_csv(arquivo_entrada, linhas)
    else:
        print(f"[ERRO] O arquivo '{arquivo_entrada}' nao foi encontrado.")
        print("   Verifique se ele esta correto.")