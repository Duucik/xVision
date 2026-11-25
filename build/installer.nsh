; xVision — дополнение к установщику (electron-builder подключает этот файл сам).
;
; Обновление поверх старой версии:
;  * копию с тем же идентификатором приложения electron-builder удаляет сам — перед установкой новой
;    он запускает старый деинсталлятор с ключами /KEEP_APP_DATA --updated (данные пользователя не трогаются);
;  * здесь мы дополнительно находим и удаляем копии, поставленные раньше под другими названиями
;    (xVision, duucikvision, Hockey Video Analysis), если они записаны в Windows под другим ключом.
;
; Данные пользователя — горячие клавиши, теги, шаги перемотки, настройки, проекты разметки, скачанная модель ИИ —
; хранятся отдельно от программы, в %APPDATA%\hockey-video-analysis-itaa, и при обновлении не удаляются.

!include LogicLib.nsh
!include FileFunc.nsh

; ---------- оформление в стиле программы ----------
; Тёмный фон шапки, первой и последней страницы; картинки — build/installerSidebar.bmp и build/installerHeader.bmp.
!define MUI_BGCOLOR "0D0E10"
!define MUI_TEXTCOLOR "F2F2F4"
!define MUI_ABORTWARNING

; Первая страница: приветствие
!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "Установка xVision ITAA"
  !define MUI_WELCOMEPAGE_TEXT "Хоккейная видеоаналитика: нарезка клипов, теги, рисование поверх видео, ИИ-подсветка игроков, работа с трансляцией и тренерская.$\r$\n$\r$\nДальше программа обновляется сама — новые установщики скачивать не нужно.$\r$\n$\r$\nПеред установкой закройте xVision ITAA, если она открыта. Нажмите «Далее», чтобы продолжить."
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW xvDarkOuter
  !insertmacro MUI_PAGE_WELCOME
  ; следующая страница («Для кого установить») получает тёмное оформление при показе
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW xvDarkPage

  ; ---------- тёмные внутренние страницы ----------
  ; Внешнее окно (полоса с кнопками внизу) и всё содержимое текущей страницы перекрашиваются в цвета программы.
  Function xvDarkOuter
    Push $0
    SetCtlColors $HWNDPARENT "F2F2F4" "0D0E10"
    GetDlgItem $0 $HWNDPARENT 1028 ; строка с названием внизу слева
    SetCtlColors $0 "6E6E78" "0D0E10"
    System::Call 'user32::InvalidateRect(p $HWNDPARENT, p 0, i 1)'
    Pop $0
  FunctionEnd

  Function xvLog
    Exch $9
    Push $8
    FileOpen $8 "$TEMP\xvdark.log" a
    FileSeek $8 0 END
    FileWrite $8 "$9$\r$\n"
    FileClose $8
    Pop $8
    Pop $9
  FunctionEnd

  Function xvDarkPage
    Push $0
    Push $1
    Push $2
    Push $3
    Push "page start"
    Call xvLog
    Call xvDarkOuter
    FindWindow $0 "#32770" "" $HWNDPARENT ; внутреннее окно страницы
    ${If} $0 == 0
      Goto xvDarkDone
    ${EndIf}
    ; страницу уже перекрасили (функция может вызываться повторно, например при вводе пути)
    System::Call 'user32::GetPropW(p r0, w "xvDark") p .r2'
    ${If} $2 != 0
      Goto xvDarkDone
    ${EndIf}
    System::Call 'user32::SetPropW(p r0, w "xvDark", p 1)'
    SetCtlColors $0 "F2F2F4" "0D0E10"
    StrCpy $1 0
    ${Do}
      FindWindow $1 "" "" $0 $1
      ${If} $1 == 0
        ${Break}
      ${EndIf}
      System::Call 'user32::GetClassNameW(p r1, w .r2, i 64)'
      Push "ctl $1 $2"
      Call xvLog
      ${If} $2 == "Edit"
        SetCtlColors $1 "F2F2F4" "1A1B20"
      ${ElseIf} $2 == "Button"
        System::Call 'user32::GetWindowLongW(p r1, i -16) i .r3'
        IntOp $3 $3 & 0xF
        ${If} $3 >= 2 ; флажки, переключатели, рамки — у обычных кнопок оставляем системный вид
          System::Call 'uxtheme::SetWindowTheme(p r1, w " ", w " ")'
          SetCtlColors $1 "F2F2F4" "0D0E10"
        ${EndIf}
      ${ElseIf} $2 == "msctls_progress32"
        System::Call 'uxtheme::SetWindowTheme(p r1, w " ", w " ")'
        SendMessage $1 0x0409 0 0x003C34E3 ; цвет полосы — красный xVision
        SendMessage $1 0x2001 0 0x00201B1A ; фон полосы
      ${ElseIf} $2 == "SysListView32"
        SendMessage $1 0x1001 0 0x00100E0D
        SendMessage $1 0x1024 0 0x00F4F2F2
        SendMessage $1 0x1026 0 0x00100E0D
      ${Else}
        SetCtlColors $1 "F2F2F4" "0D0E10"
      ${EndIf}
    ${Loop}
    System::Call 'user32::InvalidateRect(p r0, p 0, i 1)'
    Push "page done $0"
    Call xvLog
    xvDarkDone:
    Pop $3
    Pop $2
    Pop $1
    Pop $0
  FunctionEnd

  ; Страница выбора папки: своего «показа» у неё в electron-builder нет,
  ; но эта функция Windows вызывается сразу при открытии страницы — там и перекрашиваем.
  Function .onVerifyInstDir
    Push "verify $INSTDIR"
    Call xvLog
    Call xvDarkPage
  FunctionEnd
!macroend

; Страница установки (полоса прогресса)
!macro customPageAfterChangeDir
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW xvDarkPage
!macroend

; Последняя страница: «Запустить xVision» и «Создать ярлык на рабочем столе»
; Ярлык создаётся заново при каждой установке, если флажок стоит (даже если раньше его удалили вручную).
!macro customFinishPage
  !define MUI_FINISHPAGE_TITLE "xVision ITAA установлена"
  !define MUI_FINISHPAGE_TEXT "Программа готова к работе.$\r$\nМодель ИИ (около 36 МБ) скачается сама при первой подсветке игроков."
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "Запустить xVision ITAA"
  !define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
  !define MUI_FINISHPAGE_SHOWREADME ""
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "Создать ярлык на рабочем столе"
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION xvDesktopLink
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW xvFinishShow
  !define MUI_PAGE_CUSTOMFUNCTION_LEAVE xvFinishLeave
  !insertmacro MUI_PAGE_FINISH

  ; функции страницы объявляются после неё: переменные $mui.FinishPage.* появляются вместе со страницей
  Function StartApp
    ${if} ${isUpdated}
      StrCpy $1 "--updated"
    ${else}
      StrCpy $1 ""
    ${endif}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
  FunctionEnd

  Function xvDesktopLink
    Delete "$newDesktopLink"
    CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
    ClearErrors
    WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
  FunctionEnd

  Function xvFinishShow
    Call xvDarkOuter
    ; на тёмном фоне у флажков Windows рисует чёрный текст — переводим их в простой стиль, тогда цвет текста применяется
    System::Call 'uxtheme::SetWindowTheme(p $mui.FinishPage.Run, w " ", w " ")'
    System::Call 'uxtheme::SetWindowTheme(p $mui.FinishPage.ShowReadme, w " ", w " ")'
    SetCtlColors $mui.FinishPage.Run "F2F2F4" "0D0E10"
    SetCtlColors $mui.FinishPage.ShowReadme "F2F2F4" "0D0E10"
  FunctionEnd

  Function xvFinishLeave
    ; флажок ярлыка снят — убираем ярлык, если он остался от установки
    ${NSD_GetState} $mui.FinishPage.ShowReadme $0
    ${If} $0 <> ${BST_CHECKED}
      WinShell::UninstShortcut "$newDesktopLink"
      Delete "$newDesktopLink"
    ${EndIf}
  FunctionEnd

!macroend

!define XV_UNINST_ROOT "Software\Microsoft\Windows\CurrentVersion\Uninstall"

; Удалить старые копии из одного раздела реестра (HKCU — «для меня», HKLM — «для всех пользователей»)
!macro xvRemoveOldCopiesIn ROOT
  StrCpy $R9 0   ; номер ключа при переборе
  StrCpy $R0 0   ; защита от бесконечного цикла
  ${Do}
    IntOp $R0 $R0 + 1
    ${If} $R0 > 500
      ${Break}
    ${EndIf}
    ClearErrors
    EnumRegKey $R8 ${ROOT} "${XV_UNINST_ROOT}" $R9
    ${If} ${Errors}
    ${OrIf} $R8 == ""
      ${Break}
    ${EndIf}
    IntOp $R9 $R9 + 1
    ${If} $R8 == "${UNINSTALL_APP_KEY}"
      ${Continue} ; эту копию обновит сам electron-builder
    ${EndIf}

    ; наша ли это программа: название начинается с одного из прежних имён
    ReadRegStr $R7 ${ROOT} "${XV_UNINST_ROOT}\$R8" "DisplayName"
    StrCpy $R6 "0"
    StrCpy $R5 $R7 7
    ${If} $R5 == "xVision"
      StrCpy $R6 "1"
    ${EndIf}
    StrCpy $R5 $R7 12
    ${If} $R5 == "duucikvision"
      StrCpy $R6 "1"
    ${EndIf}
    StrCpy $R5 $R7 21
    ${If} $R5 == "Hockey Video Analysis"
    ${OrIf} $R5 == "hockey-video-analysis"
      StrCpy $R6 "1"
    ${EndIf}
    ${If} $R6 != "1"
      ${Continue}
    ${EndIf}

    ; путь к деинсталлятору: в строке удаления он стоит первым, обычно в кавычках
    ReadRegStr $R5 ${ROOT} "${XV_UNINST_ROOT}\$R8" "UninstallString"
    ReadRegStr $R4 ${ROOT} "${XV_UNINST_ROOT}\$R8" "InstallLocation"
    StrCpy $R3 $R5 1
    ${If} $R3 == '"'
      StrCpy $R3 $R5 "" 1
      StrCpy $R2 0
      ${Do}
        StrCpy $R1 $R3 1 $R2
        ${If} $R1 == '"'
        ${OrIf} $R1 == ""
          ${Break}
        ${EndIf}
        IntOp $R2 $R2 + 1
      ${Loop}
      StrCpy $R3 $R3 $R2
    ${Else}
      StrCpy $R3 $R5
    ${EndIf}
    ${If} $R4 == ""
      ${GetParent} $R3 $R4
    ${EndIf}

    ; ещё одна проверка, что это деинсталлятор electron-builder («Uninstall <имя>.exe»), а не чужая программа
    ${GetFileName} $R3 $R2
    StrCpy $R2 $R2 9
    ${If} $R2 != "Uninstall"
      ${Continue}
    ${EndIf}

    ${If} ${FileExists} "$R3"
      !if "${ROOT}" == "HKLM"
        StrCpy $R1 "/allusers"
      !else
        StrCpy $R1 "/currentuser"
      !endif
      ; /S — без окон; /KEEP_APP_DATA и --updated — не трогать данные пользователя; _?= — дождаться окончания
      ExecWait '"$R3" /S /KEEP_APP_DATA --updated $R1 _?=$R4'
      Delete "$R3"
      RMDir "$R4"
    ${EndIf}
    ; запись в «Программах и компонентах» могла остаться — убираем её
    DeleteRegKey ${ROOT} "${XV_UNINST_ROOT}\$R8"
    ClearErrors
    ReadRegStr $R7 ${ROOT} "${XV_UNINST_ROOT}\$R8" "DisplayName"
    ${If} ${Errors}
      StrCpy $R9 0 ; ключ удалён — нумерация сдвинулась, перебираем заново
    ${EndIf}
  ${Loop}
!macroend

!macro customInit
  Push $R0
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  Push $R5
  Push $R6
  Push $R7
  Push $R8
  Push $R9
  ; версия ITAA ставится рядом с обычной xVision — чужие копии не удаляем
  Pop $R9
  Pop $R8
  Pop $R7
  Pop $R6
  Pop $R5
  Pop $R4
  Pop $R3
  Pop $R2
  Pop $R1
  Pop $R0
!macroend
