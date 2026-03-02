# Reglas obligatorias del chat

Estas reglas son **obligatorias** para cualquier acción automatizada del asistente en este proyecto.

## 1) Prohibido usar `/tmp`

- No crear archivos, carpetas ni artefactos en rutas globales del sistema como `/tmp`, `/var/tmp` o similares.
- No usar rutas absolutas temporales fuera del workspace.

## 2) Carpeta temporal permitida

- Toda salida temporal debe ir dentro del proyecto, en:

`<RUTA_DEL_PROYECTO>/tmp`

Para este repositorio:

`/Users/hemancini/vodscene-api/tmp`

## 3) Creación de carpeta temporal

- Si `tmp` no existe, crearla automáticamente dentro del proyecto.
- Mantener cualquier archivo intermedio exclusivamente en esa carpeta.

## 4) Regla de precedencia

- Si una instrucción o script propone `/tmp`, se debe **reescribir** a `<RUTA_DEL_PROYECTO>/tmp`.
- Esta regla tiene prioridad para evitar escribir fuera del repositorio.

## 5) Ejemplos correctos

```bash
mkdir -p /Users/hemancini/vodscene-api/tmp
curl -o /Users/hemancini/vodscene-api/tmp/salida.json "https://example.com/api"
node script.js > /Users/hemancini/vodscene-api/tmp/log.txt
```

## 6) Variables sugeridas

```bash
PROJECT_TMP="/Users/hemancini/vodscene-api/tmp"
mkdir -p "$PROJECT_TMP"
```

## 7) Prohibido usar heredoc en `zsh`

- No usar bloques `heredoc` (por ejemplo `<<EOF`, `<<'EOF'`) en comandos del chat.
- Motivo: en este entorno `zsh` puede corromper la ejecución con `heredoc`.
- Usar alternativas seguras: `printf`, redirección simple (`>` / `>>`) o edición directa de archivos.

Ejemplos:

```bash
printf '%s\n' 'línea 1' 'línea 2' > /Users/hemancini/vodscene-api/tmp/archivo.txt
echo 'texto' >> /Users/hemancini/vodscene-api/tmp/archivo.txt
```

---

Aplicar estas reglas en todas las interacciones futuras del chat para este proyecto.
