define([
    '3rdparty/audiostreamsource',
    '3rdparty/codemirror/lib/codemirror',
    '3rdparty/colorutils',
    '3rdparty/cssparse',
    '3rdparty/glsl',
    '3rdparty/twgl-full',
    '3rdparty/notifier',
    './misc',
    './strings',
  ], function(
     audioStreamSource,
     CodeMirror,
     colorUtils,
     cssParse,
     glsl,
     twgl,
     Notifier,
     misc,
     strings
  ) {

  "use strict";

  // There's really no good way to tell which browsers fail.
  // Right now Safari doesn't expose AudioContext (it's still webkitAudioContext)
  // so my hope is whenever they get around to actually supporting the 3+ year old
  // standard that things will actually work.
  var shittyBrowser = window.AudioContext === undefined && /iPhone|iPad|iPod/.test(navigator.userAgent);
  var isMobile = window.navigator.userAgent.match(/Android|iPhone|iPad|iPod|Windows Phone/i);
  var $ = document.querySelector.bind(document);
  var gl;
  var s = {
    screenshotCanvas: document.createElement("canvas"),
    restoreKey: "restore",
    show: !isMobile,
  };
  s.screenshotCanvas.width = 600;
  s.screenshotCanvas.height = 336;

  function getShader(id) {
    var elem = $("#" + id);
    return (elem ? elem.text : window.vsartShaders[id]);
  }

  function ProgramManager(gl) {
    var _handlers = {};
    var _programInfo;
    var _queue = [];
    var _timeout = 500;
    var _vs;
    var _fs;
    var _prg;
    var _src;
    var _processing;

    function _emit(event) {
      var handler = _handlers[event];
      if (handler) {
        handler.apply(null, Array.prototype.slice.call(arguments, 1));
      }
    }

    function _compileShader(type, src) {
      var shader = gl.createShader(type);
      gl.shaderSource(shader, src);
      gl.compileShader(shader);
      return shader;
    }

    function _linkProgram(vs, fs) {
      var prg = gl.createProgram();
      gl.attachShader(prg, vs);
      gl.attachShader(prg, fs);
      gl.linkProgram(prg);
      return prg;
    }

    function _getShaderResults(shader) {
      var success = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
      if (!success) {
        var errors = gl.getShaderInfoLog(shader);
        console.error(errors);
        return errors;
      }
    }

    function _getProgramResults(prg) {
      var success = gl.getProgramParameter(prg, gl.LINK_STATUS);
      if (!success) {
        var errors =  gl.getProgramInfoLog(prg);
        console.error(errors);
        return errors;
      }
    }

    function _checkResults() {
      _processing = false;

      var vsErrors = _getShaderResults(_vs);
      var fsErrors = _getShaderResults(_fs);
      var prgErrors = _getProgramResults(_prg);

      // We don't need the shaders. If successful
      // they are linked in the program. In failure
      // we'll make new ones anyway.
      gl.deleteShader(_fs);
      gl.deleteShader(_vs);

      if (vsErrors === undefined &&
          fsErrors === undefined &&
          prgErrors === undefined) {
        // success!
        _emit('success', _src);
        if (_programInfo) {
          gl.deleteProgram(_programInfo.program);
        }
        _programInfo = twgl.createProgramInfoFromProgram(gl, _prg);
      } else {
        // failure
        _emit('failure', [
          vsErrors || '',
          fsErrors || '',
          prgErrors || '',
        ].join("\n"));
        gl.deleteProgram(_prg);
      }
      _processQueue();
    }

    function _processQueue() {
      if (_processing || !_queue.length) {
        return;
      }
      _processing = true;
      _src = _queue.shift();
      _vs = _compileShader(gl.VERTEX_SHADER, _src.vsrc);
      _fs = _compileShader(gl.FRAGMENT_SHADER, _src.fsrc);
      _prg = _linkProgram(_vs, _fs);
      // make sure the GPU driver executes this commands now.
      gl.flush();
      // check the results some time later.
      // this gives us a chance at async compilcation.
      setTimeout(_checkResults, _timeout);
    }

    this.on = function(event, handler) {
      _handlers[event] = handler;
    };

    // Haha! userData, just like C++. Grrr!
    this.compile = function(vsrc, fsrc, userData) {
      _queue = [{vsrc: vsrc, fsrc: fsrc, userData: userData}];
      _processQueue();
    };

    this.getProgramInfo = function() {
      return _programInfo;
    }

    this.clear = function() {
      _programInfo = undefined;
    }
  };

  function HandlerManager() {
    var handlers = [];

    this.on = function(elem, event, handler, useCapture) {
      var args = Array.prototype.slice.call(arguments, 1);
      elem.addEventListener.apply(elem, args);
      handlers.push({
        elem: elem,
        args: args,
      });
    };

    this.removeAll = function() {
      var old = handlers;
      handlers = [];
      old.forEach(function(handler) {
        handler.elem.removeEventListener.apply(handler.elem, handler.args);
      });
    };
  }

  function checkCanUseFloat(gl) {
    if (!gl.getExtension("OES_texture_float")) {
      return false;
    }

    // Can we render to float?
    var testAttachments = [
      {
        format: gl.RGBA,
        type: gl.FLOAT,
        mag: gl.NEAREST,
        min: gl.NEAREST,
        wrap: gl.CLAMP_TO_EDGE,
      },
    ];
    var testFBI = twgl.createFramebufferInfo(gl, testAttachments, 1, 1);
    gl.bindFramebuffer(gl.FRAMEBUFFER, testFBI.framebuffer);
    var status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    return status == gl.FRAMEBUFFER_COMPLETE;
  }

  var storage = window.localStorage || {
    getItem: function() {},
    setItem: function() {},
  };

  function VS() {
    var m4 = twgl.m4;
    var _pauseIcon = "❚❚";
    var _playIcon = "▶";
    var editorElem = $("#editor");
    var savingElem = $("#saving");
    var stopElem = $("#stop");
    var stopIconElem = $("#stop .stop-icon")
    var goIconElem = $("#stop .go-icon");
    var soundElem = $("#sound");
    var soundLinkElem = $("#soundLink")
    var soundLinkNode = misc.createTextNode(soundLinkElem);
    var soundcloudElem = $("#soundcloud");
    var bandLinkElem = $("#bandLink");
    var bandLinkNode = misc.createTextNode(bandLinkElem);
    var playElem = $("#play");
    var playNode = misc.createTextNode(playElem, _playIcon);
    var handlerManager = new HandlerManager();
    var on = handlerManager.on.bind(handlerManager);
    var settings = {
      lineSize: 1,
      backgroundColor: [0,0,0,1],
    };

    var g = {
      maxCount: 100000,
      mode: undefined, //gl.LINES,
      time: 0,
      mouse: [0, 0],
      shaderSuccess: false,
      vsHeader: getShader("vs-header"),
      fSource: getShader("fs"),
      errorLines: [],
      soundCloudClientId: '3f4914e324f9caeb23c521f0f1835a60',
      origSettings: { shader: "" },
      pauseOnBlur: window.location.hostname === "localhost",
      saveable: false,
      paused: false,
      touches: [],
    };
    g.errorLineNumberOffset = -g.vsHeader.split("\n").length;

    var q = misc.parseUrlQuery();
    if (q.pauseOnBlur !== undefined) {
      g.pauseOnBlur = q.pauseOnBlur.toLowerCase() === "true";
    }

    if (gl) {
      editorElem.parentNode.insertBefore(s.editorElem, editorElem);
      editorElem.parentNode.removeChild(editorElem);
      editorElem = s.editorElem;
    } else {
      gl = twgl.getWebGLContext(document.createElement("canvas"), { alpha: false });
      if (!gl) {
        $("#nogl").style.display = "";
        return;
      }

      s.canUseFloat = checkCanUseFloat(gl);
      s.canFilterFloat = s.canUseFloat && gl.getExtension("OES_texture_float_linear");
      console.log("can " + (s.canUseFloat ? "" : "not ") + "use floating point textures");
      if (s.canUseFloat) {
        console.log("can " + (s.canFilterFloat ? "" : "not ") + "filter floating point textures");
      }

      s.sets = {
        default: {
          num: 10000,
          mode: "LINES",
          sound: "",
          lineSize: "NATIVE",
          backgroundColor: [0, 0, 0, 1],
          shader: getShader("vs").trim(),
        },
        audio: {
          num: 5000,
          mode: "LINES",
          sound: "https://soundcloud.com/caseandpoint/case-point-upgrade-free-download",
          lineSize: "NATIVE",
          backgroundColor: [0, 0, 0, 1],
          shader: getShader("vs2").trim(),
        },
        audio2: {
          num: 16384,
          mode: "LINES",
          sound: "https://soundcloud.com/chibi-tech/lolitazia-season",
          lineSize: "NATIVE",
          backgroundColor: [0, 0, 0, 1],
          shader: getShader("vs3").trim(),
        },
        spiro: {
          num: 20000,
          mode: "LINES",
          sound: "",
          lineSize: "NATIVE",
          backgroundColor: [1, 1, 1, 1],
          shader: getShader("vs4").trim(),
        },
      };

      g.mode = gl.LINES;
      s.context = new (window.AudioContext || window.webkitAudioContext)();
      s.analyser = s.context.createAnalyser();
      s.analyser.connect(s.context.destination);

      var maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      s.soundTexBuffer = new Uint8Array(Math.min(maxTextureSize, s.analyser.frequencyBinCount));
      s.soundTexSpec = {
        src: s.soundTexBuffer,
        height: 1,
        min: gl.LINEAR,
        mag: gl.LINEAR,
        wrap: gl.CLAMP_TO_EDGE,
        format: gl.ALPHA,
      }
      s.soundTex = twgl.createTexture(gl, s.soundTexSpec);

      s.numHistorySamples = 60 * 4; // 4 seconds
      var historyAttachments = [
        {
          format: gl.RGBA,
          mag: gl.LINEAR,
          min: gl.LINEAR,
          wrap: gl.CLAMP_TO_EDGE,
        },
      ];
      if (q.showHistory) {
        console.log("history size:", s.soundTexBuffer.length, s.numHistorySamples);
      }

      s.historyProgramInfo = twgl.createProgramInfo(gl, [getShader("history-vs"), getShader("history-fs")]);
      s.historySrcFBI = twgl.createFramebufferInfo(gl, historyAttachments, s.soundTexBuffer.length, s.numHistorySamples);
      s.historyDstFBI = twgl.createFramebufferInfo(gl, historyAttachments, s.soundTexBuffer.length, s.numHistorySamples);

      if (s.canUseFloat) {
        var floatFilter = s.canFilterFloat ? gl.LINEAR : gl.NEAREST;
        s.floatSoundTexBuffer = new Float32Array(Math.min(maxTextureSize, s.analyser.frequencyBinCount));
        s.floatSoundTexSpec = {
          src: s.floatSoundTexBuffer,
          height: 1,
          min: floatFilter,
          mag: floatFilter,
          wrap: gl.CLAMP_TO_EDGE,
          format: gl.ALPHA,
        }
        s.floatSoundTex = twgl.createTexture(gl, s.floatSoundTexSpec);

        var floatHistoryAttachments = [
          {
            format: gl.RGBA,
            type: gl.FLOAT,
            mag: floatFilter,
            min: floatFilter,
            wrap: gl.CLAMP_TO_EDGE,
          },
        ];

        s.floatHistorySrcFBI = twgl.createFramebufferInfo(gl, floatHistoryAttachments, s.floatSoundTexBuffer.length, s.numHistorySamples);
        s.floatHistoryDstFBI = twgl.createFramebufferInfo(gl, floatHistoryAttachments, s.floatSoundTexBuffer.length, s.numHistorySamples);
      }


      var touchFilter = gl.NEAREST; //s.canUseFloat ? (s.canFilterFloat ? gl.LINEAR : gl.NEAREST) : gl.LINEAR;
      s.touchColumns = 32;
      s.touchTexBuffer = new (s.canUseFloat ? Float32Array : Uint8Array)(4 * s.touchColumns);

      s.touchTexSpec = {
        src: s.touchTexBuffer,
        height: 1,
        min: touchFilter,
        mag: touchFilter,
        wrap: gl.CLAMP_TO_EDGE,
        format: gl.RGBA,
        auto: false,
      };
      s.touchTex = twgl.createTexture(gl, s.touchTexSpec);

      var touchHistoryAttachments = [
        {
          format: gl.RGBA,
          type: s.canUseFloat ? gl.FLOAT : gl.UNSIGNED_BYTE,
          mag: touchFilter,
          min: touchFilter,
          wrap: gl.CLAMP_TO_EDGE,
          auto: false,
        },
      ];
      s.touchHistorySrcFBI = twgl.createFramebufferInfo(gl, touchHistoryAttachments, s.touchColumns, s.numHistorySamples);
      s.touchHistoryDstFBI = twgl.createFramebufferInfo(gl, touchHistoryAttachments, s.touchColumns, s.numHistorySamples);

      var count = new Float32Array(g.maxCount);
      for (var ii = 0; ii < count.length; ++ii) {
        count[ii] = ii;
      }
      var arrays = {
        vertexId: { data: count, numComponents: 1 },
      };
      s.countBufferInfo = twgl.createBufferInfoFromArrays(gl, arrays);
      s.quadBufferInfo = twgl.createBufferInfoFromArrays(gl, {
        position: { numComponents: 2, data: [-1, -1, 1, -1, -1, 1, 1, 1] },
        texcoord: [0, 0, 1, 0, 0, 1, 1, 1],
        indices: [0, 1, 2, 2, 1, 3],
      });

      s.sc = window.SC;
      if (!s.sc || q.local) {
        s.sc = new function() {
          function noop() {
            console.log("noop");
          };
          this.initialize = noop;
          this.get = function(url, options) {
            return {
              then: function(fn) {
                setTimeout(function() {
                  var longName = "This is a really long name that might mess up formatting so let's use it to test that long names don't totally mess up formatting just so we have some idea of how messed up things can get if we don't set any limits";
                  fn({
                    title: q.long ? longName : "DOCTOR VOX - Level Up [Argofox]",
                    streamable: true,
                    stream_url: "/static/resources/sounds/DOCTOR VOX - Level Up - lofi.mp3",
                    permalink_url: "http://soundcloud.com/argofox",
                    user: {
                      username: q.long ? longName : "Argofox Creative Commons",
                      permalink_url: "http://soundcloud.com/argofox",
                    }
                  });
                }, 1);
                return {
                  catch: function() {
                  },
                };
              },
            };
          }
        }
      }

      s.sc.initialize({
        client_id: g.soundCloudClientId,
      });

      s.streamSource = audioStreamSource.create({
        context: s.context,
        loop: true,
        autoPlay: true,
        crossOrigin: "anonymous",
      });
      s.streamSource.on('error', function(e) {
        console.error(e);
        setPlayState();
        setSoundSuccessState(false, e.toString());
      });
      s.streamSource.on('newSource', function(source) {
        if (!s.running) {
          s.streamSource.stop();
          return;
        }
        source.connect(s.analyser);
        setPlayState();
        setSoundSuccessState(true);
      });
      s.streamSource.on('clickToStart', function() {
        if (!g.startMobileSound) {
          if (!g.waitMobileSound) {
            g.waitMobileSound = true;
            $("#startSound").style.display = "";
            on($("#startSound"), 'click', function() {
              $("#startSound").style.display = "none";
              s.streamSource.play();
            });
          }
        }
      });

      s.programManager = new ProgramManager(gl);

      s.editorElem = editorElem;
      s.cm = CodeMirror(editorElem, {
        value: "",
        theme: "blackboard",
        mode: "x-text/x-glsl",
        lineNumbers: true,
      });
    }

    // Replace the canvas in the DOM with ours
    var c = document.getElementById("c");
    c.parentNode.insertBefore(gl.canvas, c);
    c.parentNode.removeChild(c);

    function clearRestore() {
      if (!document.hidden && !g.restoreCleared) {
        g.restoreCleared = true;
        storage.removeItem(s.restoreKey);
      }
    }

    function saveRestoreSettings() {
      if (!misc.deepCompare(settings, g.origSettings)) {
        g.restoreCleared = true;  // just in case
        storage.setItem(s.restoreKey, JSON.stringify({
          pathname: window.location.pathname,
          settings: settings,
        }));
      }
    }

    function trySave(e) {
      if (e.keyCode == 83 && (navigator.platform.match("Mac") ? e.metaKey : e.ctrlKey)) {
        e.preventDefault();
        if (g.saveFn) {
          g.saveFn();
        }
      }
    }

    on(window, 'keydown', trySave);
    on(window, 'beforeunload', saveRestoreSettings);
    on(document, 'visibilitychange', clearRestore);
    on(window, 'resize', function() {
      queueRender(true);
    });

    function takeScreenshot() {
      var touchHistoryTex = s.touchHistoryDstFBI.attachments[0];
      var historyTex = s.historyDstFBI.attachments[0];
      var floatHistoryTex = s.canUseFloat ? s.floatHistoryDstFBI.attachments[0] : historyTex;
      renderScene(touchHistoryTex, historyTex, floatHistoryTex, g.time, "CSS", [0, 0]);
      var ctx = s.screenshotCanvas.getContext("2d");
      var w = ctx.canvas.width  / gl.canvas.width;
      var h = ctx.canvas.height / gl.canvas.height;
      var scale = Math.max(w, h);
      ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      ctx.save();
      ctx.translate(ctx.canvas.width / 2 , ctx.canvas.height / 2);
      ctx.scale(scale, scale);
      ctx.translate(gl.canvas.width / -2, gl.canvas.height / -2);
      ctx.drawImage(gl.canvas, 0, 0);
      ctx.restore();
      return {
        width: ctx.canvas.width,
        height: ctx.canvas.height,
        dataURL: ctx.canvas.toDataURL.apply(ctx.canvas, arguments),
      };
    }

    //$("#gallery").addEventListener('click', function() {
    //   var shot = takeScreenshot();
    //   var img = new Image();
    //   img.src = shot.dataURL;
    //   img.style.position = "absolute";
    //   img.style.left = "0";
    //   img.style.top = "0";
    //   img.style.zIndex = 200;
    //   document.body.appendChild(img);
    //});

    var notifier = new Notifier({
      timeout: 7.5,
      container: document.body,
    });
    function addNotification(msg) {
      notifier.add({text: msg});
    }

    function setSoundSource(src) {
      s.streamSource.setSource(src);
    }

    on(playElem, 'click', function() {
      if (s.streamSource.isPlaying()) {
        s.streamSource.stop();
      } else {
        s.streamSource.play();
      }
      setPlayState();
    });

    function setPlayState() {
      playNode.nodeValue = s.streamSource.isPlaying() ? _pauseIcon : _playIcon;
    }

    function setLinkOrHide(elem, link) {
      elem.style.display = link ? "inline-block" : "none";
      if (link) {
        elem.href = link;
      }
    }

    function setSoundLink(options) {
      options = options || {};
      options.user = options.user || {};
      setLinkOrHide(soundLinkElem, options.permalink_url);
      setLinkOrHide(bandLinkElem, options.user.permalink_url);
      setLinkOrHide(soundcloudElem, options.permalink_url);
      soundLinkNode.nodeValue = options.title || "";
      bandLinkNode.nodeValue = options.user.username || "";
      if (s.cm) {
        s.cm.refresh();
      }
    }
    setSoundLink();

    function setSoundUrl(url) {
      if (!url) {
        s.streamSource.stop();
        setPlayState();
        setSoundLink();
        return;
      }
      s.sc.get("/resolve", { url: url }, function(result, err) {
        if (err) {
          console.error("bad url:", url, err);
          setSoundSuccessState(false, "not a valid soundcloud url? " + (err.message ? err.message : ""));
          return;
        }
        if (result.streamable && result.stream_url) {
          var src = result.stream_url + '?client_id=' + g.soundCloudClientId;
          setSoundSource(src);
          setSoundLink(result);
        } else {
          console.error("not streamable:", url);
          setSoundSuccessState(false, "not streamable according to soundcloud");
        }
      });
//      s.sc.get("/resolve", { url: url })
//      .then(function(result) {
//        if (result.streamable && result.stream_url) {
//          var src = result.stream_url + '?client_id=' + g.soundCloudClientId;
//          setSoundSource(src);
//          setSoundLink(result);
//        } else {
//          console.error("not streamable:", url);
//          setSoundSuccessState(false, "not streamable according to soundcloud");
//        }
//      })
//      .catch(function(e) {
//        console.error("bad url:", url, e);
//        setSoundSuccessState(false, "not a valid soundcloud url?");
//      });
    }

    on(soundElem, 'change', function(e) {
      var url = e.target.value.trim();
      if (url != settings.sound) {
        settings.sound = url;
        setSoundUrl(url);
      }
    });

    var validModes = {
      "LINES": gl.LINES,
      "LINE_STRIP": gl.LINE_STRIP,
      "LINE_LOOP": gl.LINE_LOOP,
      "POINTS": gl.POINTS,
      "TRI_STRIP": gl.TRIANGLE_STRIP,
      "TRI_FAN": gl.TRIANGLE_FAN,
      "TRIANGLES": gl.TRIANGLES,
    };

    var validLineSizes = {
      "NATIVE": true,
      "CSS": true,
    }

    var saveElem = $("#save");

    function updateStop() {
      goIconElem.style.display   = !g.pause ? "none" : "inline-block";
      stopIconElem.style.display =  g.pause ? "none" : "inline-block";
    }

    on(stopElem, 'click', function() {
      g.pause = !g.pause;
      updateStop();
      if (!g.pause) {
        queueRender();
      }
    });

    function setSoundSuccessState(success, msg) {
      soundElem.style.borderColor = success ? "" : "red";
      if (!success && msg) {
        addNotification(msg);
      }
    }

    setShaderSuccessStatus(false);

    function setShaderSuccessStatus(success) {
      var same = isSettingsSameAsOriginalSansWhitespace();
      editorElem.style.borderColor = success ? "" : "red";
      g.saveable = success && !same;
      saveElem.disabled = !g.saveable;
      g.shaderSuccess = success;
    }

    function clearLineErrors() {
      g.errorLines.forEach(function(lineHandle) {
        s.cm.doc.removeLineClass(lineHandle, "background", "errorLine");
      });
      g.errorLines = [];
    }

    var whitespaceRE = /\s\s\s*/g;
    function collapseWhitespace(s) {
      return s.replace(/\s\s*/g, ' ');
    }

    function isSettingsSameAsOriginalSansWhitespace() {
      var origShader = g.origSettings.shader;
      var newShader  = settings.shader;
      if (!origShader || !newShader) {
        return true;
      }
      g.origSettings.shader = collapseWhitespace(g.origSettings.shader);
      settings.shader = collapseWhitespace(settings.shader);
      var same = misc.deepCompare(settings, g.origSettings);
      g.origSettings.shader = origShader;
      settings.shader = newShader;
      return same;
    }

    s.programManager.on('success', function(e) {
      settings.shader = e.userData;
      setShaderSuccessStatus(true);
      clearLineErrors();
    });
    s.programManager.on('failure', function(errors) {
      setShaderSuccessStatus(false);

      clearLineErrors();

      var errorRE = /ERROR\:\s*0\:(\d+)/g;
      do {
        var m = errorRE.exec(errors);
        if (m) {
          var lineNum = parseInt(m[1]);
          if (!isNaN(lineNum) && lineNum > 0) {
            lineNum += g.errorLineNumberOffset;
            var lineHandle = s.cm.doc.getLineHandle(lineNum);
            if (lineHandle) {
              g.errorLines.push(lineHandle);
              s.cm.doc.addLineClass(lineHandle, "background", "errorLine");
            }
          }
        }
      } while (m);
    });

    function clamp(min, max, v) {
      return Math.min(max, Math.max(min, v));
    }

    var hideElem = $("#hide");
    var hideNode = misc.createTextNode(hideElem, "hide");
    function showCode(show) {
      s.show = show;
      hideNode.nodeValue = s.show ? "hide" : "show";
      editorElem.style.display = s.show ? "block" : "none";
      if (s.cm) {
        s.cm.refresh();
      }
    }
    on(hideElem, 'click', function() {
      showCode(!s.show);
    });
    showCode(s.show);

    var colorElem = $("#background");
    on(colorElem, 'change', function(e) {
      settings.backgroundColor = cssParse.parseCSSColor(e.target.value, true);
    });

    var numElem = $("#num");
    var numRangeElem = $("#numRange");

    function handleNumEdit(e) {
      var num = clamp(1, g.maxCount, parseInt(e.target.value)) | 0;
      numRangeElem.value = num;
      settings.num = num;
    }
    on(numElem, 'change', handleNumEdit);
    on(numElem, 'input', handleNumEdit);

    on(numRangeElem, 'input', function(e) {
      var num = parseInt(e.target.value);
      numElem.value = num;
      settings.num = num;
    });

    var modeElem = $("#mode");
    on(modeElem, 'change', function(e) {
      settings.mode = e.target.value.toUpperCase();
      g.mode = validModes[settings.mode];
    });

    var sizeElem = $("#size");
    on(sizeElem, 'change', function(e) {
      settings.lineSize = e.target.value.toUpperCase();
    });

    var timeElem = $("#time");
    on(timeElem, 'click', function(e) {
      g.time = 0;
    });

    var helpElem = $("#help");
    var helpDialogElem = $("#helpDialog");
    on(helpElem, 'click', function(e) {
      helpDialogElem.style.display = "";
    });
    on(helpDialogElem, 'click', function(e) {
      helpDialogElem.style.display = "none";
    });

    function isAllNumbers0to1(array) {
      for (var ii = 0; ii < array.length; ++ii) {
        var v = array[ii];
        if (typeof v !== 'number') {
          return false;
        }
        if (v < 0 || v > 1) {
          return false;
        }
      }
      return true;
    }

    s.cm.refresh();

    function getMode(mode) {
      var m = modes[mode];
      return m === undefined ? gl.LINES : m;
    }

    var mainRE = /(void[\s\S]+main[\s\S]*\([\s\S]*\)[\s\S]*\{)/g;
    function tryNewProgram(text) {
      var vsrc = g.vsHeader + text;
      vsrc = vsrc.replace(mainRE, function(m) {
        return m + "gl_PointSize=1.0;";
      });
      var lastBraceNdx = vsrc.lastIndexOf("}");
      if (lastBraceNdx >= 0) {
        var before = vsrc.substr(0, lastBraceNdx);
        var after = vsrc.substr(lastBraceNdx);
        vsrc = before + ";gl_PointSize *= _dontUseDirectly_pointSize;" + after;
      }
      setShaderSuccessStatus(false);
      s.programManager.compile(vsrc, g.fSource, text);
    }

    var oldText;
    var oldTrimmedText;

    var lineCommentRE = /\/\/.*/g;
    var blockCommentRE = /\/\*[\s\S]*?\*\//g;
    var whiteSpaceRE = /[ \t][ \t]+/g
    var eolRE = /\n\n+/g
    function trimShaderText(text) {
      text = text.replace(lineCommentRE, '');
      text = text.replace(blockCommentRE, '');
      text = text.replace(whiteSpaceRE, ' ');
      text = text.replace(eolRE, "\n");
      return text;
    }

    function handleChange(cm) {
      var text = cm.doc.getValue();
      var trimmedText = trimShaderText(text);
      if (trimmedText !== oldTrimmedText) {
        oldText = text;
        oldTrimmedText = trimmedText;
        tryNewProgram(text);
      }
    }
    s.cm.on('change', handleChange);

    function validateSettings(settings) {
      settings.num = clamp(1, g.maxCount, (settings.num || 10000) | 0);
      if (validModes[settings.mode] === undefined) {
        settings.mode = "LINES";
      }
      if (validLineSizes[settings.lineSize] === undefined) {
        settings.lineSize = "NATIVE";
      }

      var haveBG = !!settings.backgroundColor;
      var bgIsArray = Array.isArray(settings.backgroundColor);
      var bgLenIs4 = settings.backgroundColor.length === 4;
      var bgAllNum = isAllNumbers0to1(settings.backgroundColor);
      if (!haveBG ||
          !bgIsArray ||
          !bgLenIs4 ||
          !bgAllNum) {
        settings.backgroundColor = [0, 0, 0, 1];
      }
    }

    function setUISettings(settings) {
      colorElem.value = colorUtils.makeCSSColorFromRgb01Array(settings.backgroundColor);
      numElem.value = settings.num;
      numRangeElem.value = settings.num;
      modeElem.value = settings.mode;
      sizeElem.value = settings.lineSize;
      soundElem.value = settings.sound;
    }

    function markAsSaved() {
      g.origSettings = JSON.parse(JSON.stringify(settings));
      savingElem.style.display = "none";
      setShaderSuccessStatus(true);
    }

    function markAsSaving() {
      savingElem.style.display = "";
    }

    function restoreSettings(settings) {
      var restoreStr = storage.getItem(s.restoreKey);
      if (restoreStr) {
        try {
          var restore = JSON.parse(restoreStr);
          if (restore.pathname === window.location.pathname) {
            settings = restore.settings;
          }
        } catch (e) {
        }
      }
      clearRestore();
      return settings;
    }

    function setSettings(_settings, options) {
      options = options || {};
      g.saveFn = options.saveFn;
      g.restoreCleared = false;
      settings = restoreSettings(_settings);
      settings = JSON.parse(JSON.stringify(settings));
      validateSettings(settings);
      setUISettings(settings);

      g.time = 0;
      g.mode = validModes[settings.mode];
      //shader// test bad

      setSoundUrl(settings.sound);
      s.cm.doc.setValue(settings.shader);
      updateStop();
      setPlayState();

      // not needed because s.cm.doc.setValue will trigger change event
      //tryNewProgram(settings.shader);
      markAsSaved();

      s.running = true;
      queueRender();
    }

    var uniforms = {
      time: 0,
      vertexCount: 0,
      resolution: [1, 1],
      background: [0, 0, 0, 1],
      mouse: [0, 0],
      sound: undefined,
      floatSound: undefined,
      soundRes: [s.soundTexBuffer.length, s.numHistorySamples],
      _dontUseDirectly_pointSize: 1,
    };

    var historyUniforms = {
      u_mix: 0,
      u_matrix: m4.identity(),
      u_texture: undefined,
    };

    function renderScene(touchHistoryTex, soundHistoryTex, floatSoundHistoryTex, time, lineSize, mouse) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);

      var size = lineSize === "NATIVE" ? 1 : (window.devicePixelRatio || 1);
      gl.lineWidth(size);

      gl.enable(gl.DEPTH_TEST);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.clearColor.apply(gl, settings.backgroundColor);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

      var programInfo = s.programManager.getProgramInfo();
      if (programInfo) {

        uniforms.time = time;
        uniforms.vertexCount = settings.num;
        uniforms.resolution[0] = gl.canvas.width;
        uniforms.resolution[1] = gl.canvas.height;
        uniforms.background[0] = settings.backgroundColor[0];
        uniforms.background[1] = settings.backgroundColor[1];
        uniforms.background[2] = settings.backgroundColor[2];
        uniforms.background[3] = settings.backgroundColor[3];
        uniforms.mouse[0] = mouse[0];
        uniforms.mouse[1] = mouse[1];
        uniforms._dontUseDirectly_pointSize = size;
        uniforms.sound = soundHistoryTex;
        uniforms.floatSound = floatSoundHistoryTex;
        uniforms.touch = touchHistoryTex;

        gl.useProgram(programInfo.program);
        twgl.setBuffersAndAttributes(gl, programInfo, s.countBufferInfo);
        twgl.setUniforms(programInfo, uniforms);
        twgl.drawBufferInfo(gl, g.mode, s.countBufferInfo, settings.num);
      }
    }

    function updateSoundAndTouchHistory() {
      // Swap src & dst
      var temp = s.historySrcFBI;
      s.historySrcFBI = s.historyDstFBI;
      s.historyDstFBI = temp;

      if (s.canUseFloat) {
        temp = s.floatHistorySrcFBI;
        s.floatHistorySrcFBI = s.floatHistoryDstFBI;
        s.floatHistoryDstFBI = temp;
      }

      temp = s.touchHistorySrcFBI;
      s.touchHistorySrcFBI = s.touchHistoryDstFBI;
      s.touchHistoryDstFBI = temp;

      // Copy audio data to Nx1 texture
      s.analyser.getByteFrequencyData(s.soundTexBuffer);
      twgl.setTextureFromArray(gl, s.soundTex, s.soundTexSpec.src, s.soundTexSpec);

      if (s.canUseFloat) {
        s.analyser.getFloatFrequencyData(s.floatSoundTexBuffer);
        twgl.setTextureFromArray(gl, s.floatSoundTex, s.floatSoundTexSpec.src, s.floatSoundTexSpec);
      }

      // Update time
      for (var ii = 0; ii < s.touchColumns; ++ii) {
        var offset = ii * 4;
        s.touchTexBuffer[offset + 3] = g.time;
      }

      // Copy in latest touch data
      twgl.setTextureFromArray(gl, s.touchTex, s.touchTexSpec.src, s.touchTexSpec);

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.useProgram(s.historyProgramInfo.program);
      twgl.setBuffersAndAttributes(gl, s.historyProgramInfo, s.quadBufferInfo);

      gl.viewport(0, 0, s.soundTexBuffer.length, s.numHistorySamples);
      renderToHistory(0, s.historyDstFBI.framebuffer, s.historySrcFBI.attachments[0], s.soundTex);
      if (s.canUseFloat) {
        renderToHistory(0, s.floatHistoryDstFBI.framebuffer, s.floatHistorySrcFBI.attachments[0], s.floatSoundTex);
      }
      gl.viewport(0, 0, s.touchColumns, s.numHistorySamples);
      renderToHistory(1, s.touchHistoryDstFBI.framebuffer, s.touchHistorySrcFBI.attachments[0], s.touchTex);
    }

    function renderToHistory(mix, destFB, oldHistoryTex, newDataTex) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, destFB)

      // copy from historySrc to historyDst one pixel down
      m4.translation([0, 2 / s.numHistorySamples, 0], historyUniforms.u_matrix);
      historyUniforms.u_mix = 1;
      historyUniforms.u_texture = oldHistoryTex;

      twgl.setUniforms(s.historyProgramInfo, historyUniforms);
      twgl.drawBufferInfo(gl, gl.TRIANGLES, s.quadBufferInfo);

      // copy audio data into top row of historyDst
      historyUniforms.u_mix = mix;
      historyUniforms.u_texture = newDataTex;
      m4.translation(
          [0, -(s.numHistorySamples - 0.5) / s.numHistorySamples, 0],
          historyUniforms.u_matrix)
      m4.scale(
          historyUniforms.u_matrix,
          [1, 1 / s.numHistorySamples, 1],
          historyUniforms.u_matrix);

      twgl.setUniforms(s.historyProgramInfo, historyUniforms);
      twgl.drawBufferInfo(gl, gl.TRIANGLES, s.quadBufferInfo);
    }

    function renderHistory(tex, mix) {
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.useProgram(s.historyProgramInfo.program);
      twgl.setBuffersAndAttributes(gl, s.historyProgramInfo, s.quadBufferInfo);
      m4.identity(historyUniforms.u_matrix);
      historyUniforms.u_mix = mix;
      historyUniforms.u_texture = tex;
      twgl.setUniforms(s.historyProgramInfo, historyUniforms);
      twgl.drawBufferInfo(gl, gl.TRIANGLES, s.quadBufferInfo);
    }

    function render(time) {
      g.requestId = undefined;
      time *= 0.001;
      var now = time;
      var elapsed = now - (g.then || 0);
      g.then = now;
      g.time += elapsed;

      twgl.resizeCanvasToDisplaySize(gl.canvas);

      updateSoundAndTouchHistory();

      var touchHistoryTex = s.touchHistoryDstFBI.attachments[0];
      var historyTex = s.historyDstFBI.attachments[0];
      var floatHistoryTex = s.canUseFloat ? s.floatHistoryDstFBI.attachments[0] : historyTex;
      renderScene(touchHistoryTex, historyTex, floatHistoryTex, g.time, settings.lineSize, g.mouse);

      if (q.showHistory) {
        renderHistory(s.historyDstFBI.attachments[0], 0);
      }
      if (q.showFloatHistory && s.canUseFloat) {
        renderHistory(s.floatHistoryDstFBI.attachments[0], 0);
      }
      if (q.showTouchHistory) {
        renderHistory(s.touchHistoryDstFBI.attachments[0], 1);
      }

      queueRender();
    }

    function queueRender(force) {
      if (!g.requestId && (force || !g.pause)) {
        g.requestId = requestAnimationFrame(render);
      }
    }

    function stopRender() {
      if (g.requestId) {
        cancelAnimationFrame(g.requestId);
        g.requestId = undefined;
      }
    }

    function pauseOnBlur() {
      if (g.pauseOnBlur) {
        stopRender();
      }
    }

    function unpauseOnFocus() {
      if (g.pauseOnBlur && s.running) {
        queueRender();
      }
    }

    on(window, 'blur', pauseOnBlur);
    on(window, 'focus', unpauseOnFocus);

    function addTouchPosition(column, x, y) {
      x = x *  2 - 1;
      y = y * -2 + 1;

      if (!s.canUseFloat) {
        x = Math.max(0, x * 255 | 0);
        y = Math.max(0, y * 255 | 0);
      }
      var offset = column * 4;
      s.touchTexBuffer[offset + 0] = x;
      s.touchTexBuffer[offset + 1] = y;
    }

    function addTouchPressure(column, pressure) {
      var time = g.time;
      if (!s.canUseFloat) {
        pressure = Math.max(0, pressure * 255 | 0);
        time     = time % 256;
      }
      var offset = column * 4;
      s.touchTexBuffer[offset + 2] = pressure;
    }

    function recordMouseMove(e) {
      var w = window.innerWidth;
      var h = window.innerHeight;
      var x = e.clientX / w;
      var y = e.clientY / h;

      g.mouse = [x * 2 - 1, y * -2 + 1];
      addTouchPosition(0, x, y);
    }

    function recordMouseDown(e) {
      addTouchPressure(0, 1);
    }

    function recordMouseUp(e) {
      addTouchPressure(0, 0);
    }

    on(window, 'mousemove', recordMouseMove);
    on(window, 'mousedown', recordMouseDown);
    on(window, 'mouseup', recordMouseUp);

    function getTouchIndex(t) {
      var id = t.identifer;
      var ndx = g.touches.indexOf(id);
      if (ndx < 0) {
        // Find empty slot
        for (var ii = 0; ii < g.touches.length; ++ii) {
          if (g.touches[ii] === undefined) {
            break;
          }
        }
        if (ii == 32) {
          console.error("too many touches :(");
          g.touches = [];
          ii = 0;
        }
        ndx = ii;
        g.touches[ndx] = id;
      }
      return ndx;
    }

    function recordTouchStart(e) {
      for (var ii = 0; ii < e.touches.length; ++ii) {
        var t = e.touches[ii];
        var w = window.innerWidth;
        var h = window.innerHeight;
        var x = t.clientX / w;
        var y = t.clientY / h;
        var ndx = getTouchIndex(t);
        addTouchPosition(ndx, x, y);
        addTouchPressure(ndx, t.force || 1);
      }
    }

    function recordTouchCancel(e) {
      for (var ii = 0; ii < e.touches.length; ++ii) {
        var t = e.touches[ii];
        var ndx = getTouchIndex(t);
        g.touches[ndx] === undefined;
        addTouchPressure(ndx, 0);
      }
    }

    function recordTouchEnd(e) {
      recordTouchCancel(e);
    }

    function recordTouchMove(e) {
      e.preventDefault();
      recordTouchStart(e);
      return false;
    }

    var touchTarget = window;
    on(touchTarget, 'touchstart', recordTouchStart);
    on(touchTarget, 'touchend', recordTouchEnd);
    on(touchTarget, 'touchcancel', recordTouchCancel);
    on(touchTarget, 'touchmove', recordTouchMove);

    this.stop = function() {
      s.running = false;
      stopRender();
      if (s.streamSource.isPlaying()) {
        s.streamSource.stop();
      }
      s.programManager.clear();
      handlerManager.removeAll();
      clearLineErrors();
      s.cm.off('change', handleChange);
      gl.canvas.parentNode.removeChild(gl.canvas);
      saveRestoreSettings();
    }

    this.takeScreenshot = takeScreenshot;
    this.setSettings = setSettings;
    this.getSettings = function() {
      return JSON.parse(JSON.stringify(settings));
    };
    this.getSets = function() {
      return s.sets;
    };
    this.markAsSaved = markAsSaved;
    this.markAsSaving = markAsSaving;
    this.isSaveable = function() {
      return g.saveable;
    }
  }

  var vs;

  function init() {
    if (!vs) {
      vs = new VS();
    }
  }

  function start() {
    init();

    var q = misc.parseUrlQuery();
    var settings = s.sets[q.settings];
    if (!settings) {
      settings = s.sets.default;
    }

    vs.setSettings(settings);
  }

  function stop() {
    if (vs) {
      vs.stop();
    }
  }

  function setSettings(settings, options) {
    vs = new VS(); //init();

    if (!settings) {
      // pick a random settings
      var sets = vs.getSets();
      var keys = Object.keys(sets);
      var ndx = Math.random() * keys.length | 0;
      settings = sets[keys[ndx]];
    }

    vs.setSettings(settings, options);
  }

  function getSettings() {
    init();
    return vs.getSettings();
  }

  function takeScreenshot() {
    init();
    return vs.takeScreenshot.apply(vs, arguments);
  }

  function markAsSaved() {
    init();
    vs.markAsSaved();
  }

  function markAsSaving() {
    init();
    vs.markAsSaving();
  }

  function isSaveable() {
    init();
    return vs.isSaveable();
  }

  var missingSettings = {
    num: 256,
    mode: "POINTS",
    sound: "",
    lineSize: "NATIVE",
    backgroundColor: [0, 0, 0, 1],
    shader: [
      "// -----[ shader missing! ] -----",
      "",
      "#define NUM 15.0",
      "void main() {",
      "  gl_PointSize = 64.0;",
      "  float col = mod(vertexId, NUM + 1.0);",
      "  float row = mod(floor(vertexId / NUM), NUM + 1.0); ",
      "  float x = col / NUM * 2.0 - 1.0;",
      "  float y = row / NUM * 2.0 - 1.0;",
      "  gl_Position = vec4(x, y, 0, 1);",
      "  v_color = vec4(fract(time + col / NUM + row / NUM), 0, 0, 1);",
      "}",
    ].join("\n"),
  };

  return {
    start: start,
    stop: stop,
    isSaveable: isSaveable,
    getSettings: getSettings,
    setSettings: setSettings,
    takeScreenshot: takeScreenshot,
    missingSettings: missingSettings,
    markAsSaved: markAsSaved,
    markAsSaving: markAsSaving,
  };
});
