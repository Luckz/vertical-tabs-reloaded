/* ***** BEGIN LICENSE BLOCK *****
 *
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * If a copy of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * ***** END LICENSE BLOCK ***** */

var { Cc, Ci, Cu } = require('chrome');
 
Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://verticaltabsreloaded/lib/tabdatastore.jsm");
Cu.import("resource://verticaltabsreloaded/lib/multiselect.jsm");
Cu.import("resource://verticaltabsreloaded/lib/groups.jsm");

let console = (Cu.import("resource://gre/modules/Console.jsm", {})).console;
var { Hotkey } = require("sdk/hotkeys");

const EXPORTED_SYMBOLS = ["VerticalTabs"];

const NS_XUL = "http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul";
const TAB_DROP_TYPE = "application/x-moz-tabbrowser-tab";

/*
 * Vertical Tabs
 *
 * Main entry point of this add-on.
 */
function VerticalTabs(window) {
    this.window = window;
    this.document = window.document;
	this.toggleDisplayHotkey;
	this.changedDisplayState = false;
    this.unloaders = [];
    this.init();
}

VerticalTabs.prototype = {
	init: function() {
		this.window.VerticalTabs = this;
		this.unloaders.push(function() {
				delete this.window.VerticalTabs;
		});

		this.sss = Cc["@mozilla.org/content/style-sheet-service;1"]
								.getService(Ci.nsIStyleSheetService);
		this.ios = Cc["@mozilla.org/network/io-service;1"]
								.getService(Ci.nsIIOService);


		this.installStylesheet("resource://verticaltabsreloaded/data/override-bindings.css");
		this.installStylesheet("resource://verticaltabsreloaded/data/skin/bindings.css");
		this.installStylesheet("resource://verticaltabsreloaded/data/skin/base.css");
		this.applyThemeStylesheet();
		this.unloaders.push(this.removeThemeStylesheet);

		this.rearrangeXUL();
		this.initContextMenu();
		this.observeThemePref();
		this.observePrefs();
		this.initHotkeys();

		let tabs = this.document.getElementById("tabbrowser-tabs");
		this.tabIDs = new VTTabIDs(tabs);
		this.unloaders.push(function() {
			this.tabIDs.unload();
		});
	
		this.window.addEventListener("sizemodechange", this, false);
		this.unloaders.push(function unloadSizeModeChangeListener() {
			this.window.removeEventListener("sizemodechange", this, false);
		});
	},

	installStylesheet: function(uri) {
			uri = this.ios.newURI(uri, null, null);
			this.sss.loadAndRegisterSheet(uri, this.sss.USER_SHEET);
	},

	applyThemeStylesheet: function() {
		this.theme = Services.prefs.getCharPref("extensions.@verticaltabsreloaded.theme");
		this.installStylesheet(this.getThemeStylesheet(this.theme));
	},

	removeThemeStylesheet: function() {
		var uri = this.ios.newURI(this.getThemeStylesheet(this.theme), null, null);
		this.sss.unregisterSheet(uri, this.sss.USER_SHEET);
	},

	getThemeStylesheet: function(theme) {
		var stylesheet;
		switch (theme) {
		case "winnt":
			stylesheet = "resource://verticaltabsreloaded/data/skin/default/win7/win7.css";
			break;
		case "darwin":
			stylesheet = "resource://verticaltabsreloaded/data/skin/default/osx/osx.css";
			break;
		case "linux":
			stylesheet = "resource://verticaltabsreloaded/data/skin/default/linux/linux.css";
			break;
		case "light":
			stylesheet = "resource://verticaltabsreloaded/data/skin/light/light.css";
			break;
		case "dark":
		default:
			stylesheet = "resource://verticaltabsreloaded/data/skin/dark/dark.css";
			break;
		}

		return stylesheet;
	},

	rearrangeXUL: function() {
		const window = this.window;
		const document = this.document;

		// Move the bottom stuff (findbar, addonbar, etc.) in with the
		// tabbrowser.  That way it will share the same (horizontal)
		// space as the brower.  In other words, the bottom stuff no
		// longer extends across the whole bottom of the window.
		let contentbox = document.getElementById("appcontent");
		let bottom = document.getElementById("browser-bottombox");
		contentbox.appendChild(bottom);

		// Create a box next to the app content. It will hold the tab
		// bar and the tab toolbar.
		let browserbox = document.getElementById("browser");
		let leftbox = document.createElementNS(NS_XUL, "vbox");
		leftbox.id = "verticaltabs-box";
		browserbox.insertBefore(leftbox, contentbox);

		let splitter = document.createElementNS(NS_XUL, "splitter");
		splitter.id = "verticaltabs-splitter";
		splitter.className = "chromeclass-extrachrome";
		browserbox.insertBefore(splitter, contentbox);
		// Hook up event handler for splitter so that the width of the
		// tab bar is persisted.
		splitter.addEventListener("mouseup", this, false);

		// Move the tabs next to the app content, make them vertical,
		// and restore their width from previous session
		if (Services.prefs.getBoolPref("extensions.@verticaltabsreloaded.right")) {
			browserbox.dir = "reverse";
		}

		let tabs = document.getElementById("tabbrowser-tabs");
		leftbox.insertBefore(tabs, leftbox.firstChild);
		tabs.orient = "vertical";
		tabs.mTabstrip.orient = "vertical";
		tabs.tabbox.orient = "horizontal"; // probably not necessary
		tabs.setAttribute("width", Services.prefs.getIntPref("extensions.@verticaltabsreloaded.width"));

		// Move the tabs toolbar into the tab strip
		let toolbar = document.getElementById("TabsToolbar");
		toolbar.setAttribute("collapsed", "false"); // no more vanishing new tab toolbar
		toolbar._toolbox = null; // reset value set by constructor
		toolbar.setAttribute("toolboxid", "navigator-toolbox");
		leftbox.appendChild(toolbar);

		// Not sure what this does, it and all related code might be unnecessary
		window.TabsOnTop = window.TabsOnTop ? window.TabsOnTop : {};
		window.TabsOnTop.enabled = false;

		let toolbar_context_menu = document.getElementById("toolbar-context-menu");
		toolbar_context_menu.firstChild.collapsed = true;
		toolbar_context_menu.firstChild.nextSibling.collapsed = true; // separator

		tabs.addEventListener("TabOpen", this, false);
		for (let i=0; i < tabs.childNodes.length; i++) {
			this.initTab(tabs.childNodes[i]);
		}

		this.window.addEventListener("resize", this, false);

		this.unloaders.push(function() {
			// Move the bottom back to being the next sibling of contentbox.
			browserbox.insertBefore(bottom, contentbox.nextSibling);

			// Move the tabs toolbar back to where it was
			toolbar._toolbox = null; // reset value set by constructor
			toolbar.removeAttribute("toolboxid");
			let toolbox = document.getElementById("navigator-toolbox");
			let navbar = document.getElementById("nav-bar");
			//toolbox.appendChild(toolbar);

			// Restore the tab strip.
			toolbox.insertBefore(toolbar, navbar);

			let new_tab_button = document.getElementById("new-tab-button");

			// Put the tabs back up dur
			toolbar.insertBefore(tabs, new_tab_button);
			tabs.orient = "horizontal";
			tabs.mTabstrip.orient = "horizontal";
			tabs.tabbox.orient = "vertical"; // probably not necessary
			tabs.removeAttribute("width");
			tabs.removeEventListener("TabOpen", this, false);

			// Restore tabs on top.
			window.TabsOnTop.enabled = Services.prefs.getBoolPref("extensions.@verticaltabsreloaded.tabsOnTop");
			toolbar_context_menu.firstChild.collapsed = false;
			toolbar_context_menu.firstChild.nextSibling.collapsed = false; // separator

			// Restore all individual tabs.
			for (let i = 0; i < tabs.childNodes.length; i++) {
				let tab = tabs.childNodes[i];
				tab.removeAttribute("align");
				tab.maxWidth = tab.minWidth = "";
			}

			// Remove all the crap we added.
			splitter.removeEventListener("mouseup", this, false);
			browserbox.removeChild(leftbox);
			browserbox.removeChild(splitter);
			browserbox.dir = "normal";
			leftbox = splitter = null;
		});
	},

	initContextMenu: function() {
		const document = this.document;
		const tabs = document.getElementById("tabbrowser-tabs");

		let closeMultiple = null;
		if (this.multiSelect) {
			closeMultiple = document.createElementNS(NS_XUL, "menuitem");
			closeMultiple.id = "context_verticalTabsCloseMultiple";
			closeMultiple.setAttribute("label", "Close Selected Tabs"); //TODO l10n
			closeMultiple.setAttribute("tbattr", "tabbrowser-multiple");
			closeMultiple.setAttribute("oncommand", "gBrowser.tabContainer.VTMultiSelect.closeSelected();");
			tabs.contextMenu.appendChild(closeMultiple);
		}

		tabs.contextMenu.addEventListener("popupshowing", this, false);

		this.unloaders.push(function() {
			if (closeMultiple)
					tabs.contextMenu.removeChild(closeMultiple);
			tabs.contextMenu.removeEventListener("popupshowing", this, false);
		});
	},

	initHotkeys: function() {
		let vt = this;
		vt.toggleDisplayHotkey = Hotkey({
			combo: Services.prefs.getCharPref("extensions.@verticaltabsreloaded.toggleDisplayHotkey"),
			onPress: function() {
				vt.toggleDisplayState();
			}
		});
		
		this.unloaders.push(function() {
			vt.toggleDisplayHotkey.destroy();
		});
	},
	
	initTab: function(aTab) {
		aTab.setAttribute("align", "stretch");
		aTab.maxWidth = 65000;
		aTab.minWidth = 0;
	},

	setPinnedSizes: function() {
		let tabs = this.document.getElementById("tabbrowser-tabs");
		// awfulness
		let numPinned = tabs.tabbrowser._numPinnedTabs;

		if (tabs.getAttribute("positionpinnedtabs")) {
				let width = tabs.boxObject.width;
				for (let i = 0; i < numPinned; ++i) {
						tabs.childNodes[i].style.width = tabs.boxObject.width + "px";
				}
		} else {
			for (let i = 0; i < numPinned; ++i) {
				tabs.childNodes[i].style.width = "";
			}
		}
	},

	onTabbarResized: function() {
		let tabs = this.document.getElementById("tabbrowser-tabs");
		this.setPinnedSizes();
		this.window.setTimeout(function() {
				Services.prefs.setIntPref("extensions.@verticaltabsreloaded.width", tabs.boxObject.width);
		}, 10);
	},

	observePrefs: function() {
		Services.prefs.addObserver("extensions.@verticaltabsreloaded.", this, false);
		this.unloaders.push(function() {
			Services.prefs.removeObserver("extensions.@verticaltabsreloaded.", this, false);
		});
	},

	observeThemePref: function() {
		Services.prefs.addObserver("extensions.@verticaltabsreloaded.theme", this, false);
		this.unloaders.push(function() {
			Services.prefs.removeObserver("extensions.@verticaltabsreloaded.theme", this, false);
		});
	},

	observe: function(subject, topic, data) {
		if (topic != "nsPref:changed") {
			return;
		}

		switch (data) {
			case "extensions.@verticaltabsreloaded.right":
				let browserbox = this.document.getElementById("browser");
				if (browserbox.dir != "reverse") {
					browserbox.dir = "reverse";
				} else {
					browserbox.dir = "normal";
				}
				break;
			case "extensions.@verticaltabsreloaded.theme":
				console.log("updating theme");
				this.removeThemeStylesheet();
				this.applyThemeStylesheet();
				break;
			case "extensions.@verticaltabsreloaded.hideInFullscreen":
				// call manually, so we re-show tabs when in fullscreen
				this.onSizeModeChange();
				break;
			case "extensions.@verticaltabsreloaded.toggleDisplayHotkey":
				this.toggleDisplayHotkey.destroy();
				this.initHotkeys();
				break;
		}
	},

	unload: function() {
		this.unloaders.forEach(function(func) {
			func.call(this);
		}, this);
	},

	// Event handlers

	handleEvent: function(aEvent) {
		switch (aEvent.type) {
		case "DOMContentLoaded":
			this.init();
			return;
		case "TabOpen":
			this.onTabOpen(aEvent);
			this.setPinnedSizes();
			return;
		case "mouseup":
			this.onMouseUp(aEvent);
			return;
		case "sizemodechange":
			this.onSizeModeChange(aEvent);
			return;
		case "popupshowing":
			this.onPopupShowing(aEvent);
			return;
		case "resize":
			this.setPinnedSizes();
			return;
		}
	},

	toggleDisplayState: function() {
		const document = this.document;
		
		if(document.getElementById("verticaltabs-box").style.display == "")
		{
			this.changeDisplayState("none");
			this.changedDisplayState = true;
		}
		else
		{
			this.changeDisplayState("");
			this.changedDisplayState = false;
		}
	},
	
	changeDisplayState: function(display) {
		const document = this.document;
		
		let tabs = document.getElementById("verticaltabs-box").style;
		let splitter = document.getElementById("verticaltabs-splitter").style;

		if (tabs.display == display && splitter.display == display) {
			return;
		}

		tabs.display = splitter.display = display;
	},
	
	onSizeModeChange: function() {
		if(this.changedDisplayState == true) 
		{
			return;
		}
		
		const window = this.window;
		const document = this.document;

		let hideOk = Services.prefs.getBoolPref("extensions.@verticaltabsreloaded.hideInFullscreen");
		let display = hideOk && window.windowState == window.STATE_FULLSCREEN ? "none" : "";

		this.changeDisplayState(display);
	},

	
	onTabOpen: function(aEvent) {
		this.initTab(aEvent.target);
	},

	onMouseUp: function(aEvent) {
		if (aEvent.target.getAttribute("id") == "verticaltabs-splitter") {
			this.onTabbarResized();
		}
	},

	onPopupShowing: function(aEvent) {
		if (!this.multiSelect)
			return;

		let closeTabs = this.document.getElementById("context_verticalTabsCloseMultiple");
		let tabs = this.multiSelect.getSelected();
		if (tabs.length > 1) {
			closeTabs.disabled = false;
		} else {
			closeTabs.disabled = true;
		}
	}
  
};