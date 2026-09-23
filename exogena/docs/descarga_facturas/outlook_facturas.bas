Attribute VB_Name = "FacturasExogena"
' Exógena YC · Descarga masiva de facturas electrónicas desde Outlook de escritorio (Windows).
'
' Guarda en una carpeta del computador todos los adjuntos .zip y .xml de los correos recibidos en el
' rango de fechas, de la carpeta de Outlook que usted elija (y sus subcarpetas).
'
' Uso:
'   1. En Outlook: Alt+F11 (editor de Visual Basic) -> Archivo -> Importar archivo -> este .bas
'      (o Insertar -> Módulo y pegue el texto).
'   2. Ajuste CARPETA_DESTINO, DESDE y HASTA.
'   3. Ejecute GuardarFacturas (F5). Elija la carpeta del buzón donde llegan las facturas.
'   4. Seleccione todos los archivos de la carpeta destino (Ctrl+E) y cárguelos en el aplicativo
'      (Procesar exógena -> Facturas electrónicas).
' Si Outlook bloquea las macros: Archivo -> Opciones -> Centro de confianza -> Configuración de macros.
' Solo lee correos y guarda archivos. No borra, no mueve y no envía nada.
Option Explicit

Private Const CARPETA_DESTINO As String = "C:\Facturas_AG2025\"
Private Const DESDE As Date = #1/1/2025#
Private Const HASTA As Date = #1/1/2026#      ' exclusiva

Private guardados As Long

Public Sub GuardarFacturas()
    Dim origen As Outlook.Folder
    Set origen = Application.Session.PickFolder
    If origen Is Nothing Then Exit Sub
    If Dir(CARPETA_DESTINO, vbDirectory) = "" Then MkDir CARPETA_DESTINO
    guardados = 0
    RecorrerCarpeta origen
    MsgBox guardados & " adjuntos guardados en " & CARPETA_DESTINO, vbInformation, "Exógena YC"
End Sub

Private Sub RecorrerCarpeta(ByVal carpeta As Outlook.Folder)
    Dim i As Long, it As Object, adj As Outlook.Attachment, ext As String
    For i = 1 To carpeta.Items.Count
        Set it = carpeta.Items(i)
        If TypeOf it Is Outlook.MailItem Then
            If it.ReceivedTime >= DESDE And it.ReceivedTime < HASTA Then
                For Each adj In it.Attachments
                    ext = LCase$(Right$(adj.FileName, 4))
                    If ext = ".zip" Or ext = ".xml" Then
                        guardados = guardados + 1
                        adj.SaveAsFile CARPETA_DESTINO & Format$(guardados, "000000") & "_" & adj.FileName
                    End If
                Next
            End If
        End If
        If i Mod 200 = 0 Then DoEvents
    Next
    Dim sub_ As Outlook.Folder
    For Each sub_ In carpeta.Folders
        RecorrerCarpeta sub_
    Next
End Sub
