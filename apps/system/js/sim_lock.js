/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */

'use strict';

var SimLock = {
  _duringCall: false,
  _showPrevented: false,

  init: function sl_init() {
    // Do not do anything if there's no SIMSlot instance.
    if (!SIMSlotManager.length)
      return;

    this.onClose = this.onClose.bind(this);

    // for bootup special case
    this.showIfLocked();

    window.addEventListener('ftuopen', this);

    // Watch for apps that need a mobile connection
    window.addEventListener('appopened', this);

    // Display the dialog only after lockscreen is unlocked
    // before the transition.
    // To prevent keyboard being displayed behind it.
    //
    // And we can't listen to 'lockscreen-appclosing' event because
    // we need to detect if the next app is Camera.
    window.addEventListener('lockscreen-request-unlock', this);

    // always monitor card state change
    var self = this;
    window.addEventListener('simslot-cardstatechange', function(evt) {
      self.showIfLocked(evt.detail.index);
    });

    // In some case, we can have 'iccdetected' and then 'iccinfochange'
    // happening after 'cardstatechange'. We add a listener on
    // 'simslot-iccinfochange' and if the SIM is locked, we will display the SIM
    // PIN UI.
    window.addEventListener('simslot-iccinfochange', function(evt) {
      self.showIfLocked(evt.detail.index);
    });

    // Listen to callscreen window's opening and terminated events
    // to discard the cardstatechange event.
    window.addEventListener('attentionopening', this);
    window.addEventListener('attentionterminated', this);

    // Listen to events fired from SIMPINDialog
    window.addEventListener('simpinskip', this);
    window.addEventListener('simpinback', this);
    window.addEventListener('simpinrequestclose', this);
  },

  handleEvent: function sl_handleEvent(evt) {
    switch (evt.type) {
      case 'ftuopen':
        VersionHelper.getVersionInfo().then(function(info) {
          if (!info.isUpgrade()) {
            SimPinDialog.close();
          }
        });
        break;
      case 'simpinback':
        var index = evt.detail._currentSlot.index;
        this.showIfLocked(index - 1);
        break;
      // Test if there's still any card is locking.
      case 'simpinskip':
        var index = evt.detail._currentSlot.index;
        if (index + 1 >= this.length - 1) {
          evt.detail.close('skip');
        } else {
          if (!this.showIfLocked(index + 1, true)) {
            evt.detail.close('skip');
          }
        }
        break;
      case 'simpinrequestclose':
        var index = evt.detail.dialog._currentSlot.index;
        if (index + 1 >= this.length - 1) {
          evt.detail.dialog.close(evt.detail.reason);
        } else {
          if (!this.showIfLocked(index + 1, true)) {
            evt.detail.dialog.close(evt.detail.reason);
          }
        }
        break;
      case 'attentionopening':
        if (evt.detail.CLASS_NAME !== 'CallscreenWindow') {
          return;
        }
        this._duringCall = true;
        break;
      case 'attentionterminated':
        if (evt.detail.CLASS_NAME !== 'CallscreenWindow') {
          return;
        }
        this._duringCall = false;
        if (this._showPrevented) {
          this._showPrevented = false;

          // We show the SIM dialog right away otherwise the user won't
          // be able to receive calls.
          this.showIfLocked();
        }
        break;
      case 'lockscreen-request-unlock':
        // Check whether the lock screen was unlocked from the camera or not.
        // If the former is true, the SIM PIN dialog should not displayed after
        // unlock, because the camera will be opened (Bug 849718)
        if (evt.detail && evt.detail.activity &&
            'record' === evt.detail.activity.name) {
          if (SimPinDialog.visible) {
            SimPinDialog.close();
          }
          return;
        }
        var self = this;
        // We should wait for lockscreen-appclosed event sent before checking
        // the value of System.locked in showIfLocked method.
        window.addEventListener('lockscreen-appclosed',
          function lockscreenOnClosed() {
            window.removeEventListener('lockscreen-appclosed',
              lockscreenOnClosed);
            self.showIfLocked();
          });
        break;
      case 'appopened':
        // If an app needs 'telephony' or 'sms' permissions (i.e. mobile
        // connection) and the SIM card is locked, the SIM PIN unlock screen
        // should be launched

        var app = evt.detail;

        if (!app || !app.manifest || !app.manifest.permissions)
          return;

        // Ignore first time usage (FTU) app which already asks for the PIN code
        // XXX: We should have a better way to detect this app is FTU or not.
        if (app.origin == FtuLauncher.getFtuOrigin())
          return;

        // Ignore apps that don't require a mobile connection
        if (!('telephony' in app.manifest.permissions ||
              'sms' in app.manifest.permissions))
          return;

        // If the Settings app will open, don't prompt for SIM PIN entry
        // although it has 'telephony' permission (Bug 861206)
        var settingsManifestURL =
          'app://settings.gaiamobile.org/manifest.webapp';
        if (app.manifestURL == settingsManifestURL)
          return;

        // If SIM is locked, cancel app opening in order to display
        // it after the SIM PIN dialog is shown
        this.showIfLocked();
        // XXX: We don't block the app from launching if it requires SIM
        // but only put the SIM PIN dialog upon the opening/opened app.
        // Will revisit this in
        // https://bugzilla.mozilla.org/show_bug.cgi?id=SIMPIN-Dialog

        break;
    }
  },

  showIfLocked: function sl_showIfLocked(currentSlotIndex, skipped) {
    if (System.locked)
      return false;

    // FTU has its specific SIM PIN UI
    if (FtuLauncher.isFtuRunning() && !FtuLauncher.isFtuUpgrading()) {
      SimPinDialog.close();
      return false;
    }

    if (this._duringCall) {
      this._showPrevented = true;
      return false;
    }
    var locked = false;

    return SIMSlotManager.getSlots().some(function iterator(slot, index) {
      if (currentSlotIndex && index !== currentSlotIndex) {
        return false;
      }

      if (!slot.simCard) {
        return false;
      }

      switch (slot.simCard.cardState) {
        // do nothing in either unknown or null card states
        case null:
        case 'unknown':
          break;
        case 'pukRequired':
        case 'pinRequired':
          SimPinDialog.show(slot, this.onClose.bind(this), skipped);
          return true;
        case 'networkLocked':
        case 'corporateLocked':
        case 'serviceProviderLocked':
        case 'network1Locked':
        case 'network2Locked':
        case 'hrpdNetworkLocked':
        case 'ruimCorporateLocked':
        case 'ruimServiceProviderLocked':
          SimPinDialog.show(slot, this.onClose.bind(this), skipped);
          return true;
      }
    }, this);
  },

  onClose: function sl_onClose(reason) {
    // XXX: We are not blocking app to be opened since bug 907013
    // so we don't need to re-display the app here.
  }
};

function preInit() {
  if (SIMSlotManager.ready) {
    SimLock.init();
  } else {
    window.addEventListener('simslotready', function ready() {
      window.removeEventListener('simslotready', ready);
      SimLock.init();
    });
  }
}

// SIMLock will optionally load SIMLock dialog which is blocked by l10n
navigator.mozL10n.once(preInit);
