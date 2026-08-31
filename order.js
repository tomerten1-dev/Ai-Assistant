Date.prototype.add || (Date.prototype.add = function(a, u){
    var d = new Date(this.valueOf());
    switch(u){
        case 'y': case 'Y': d.setFullYear(d.getFullYear() + parseInt(a)); break;
        case 'm': case 'M': d.setMonth(d.getMonth() + parseInt(a)); break;
        default: d.setDate(d.getDate() + parseInt(a));
    }
    return d;
});

Date.dayLength = 1000 * 60 * 60 * 24;
Date.prototype.diff || (Date.prototype.diff = function(d){
    return Math.round(Math.abs(this - d) / Date.dayLength);
});

Date.prototype.toDB || (Date.prototype.toDB = function(){
    return [this.getFullYear(), ('0' + (this.getMonth() + 1)).substr(-2), ('0' + this.getDate()).substr(-2)].join('-');
});

Number.prototype.round || (Number.prototype.round = function (len) {
    var m = (len >= 0) ? Math.pow(10, Math.min(len, 8)) : 1;
    return Math.round(this * m) / m;
});

String.prototype.flipDate || (String.prototype.flipDate = function(nd) {
    var d = this.match(/^\d+(\D)\d+\1\d{2,4}$/);
    return d ? this.split(d[1]).reverse().join(nd === undefined ? d[1] : nd) : this;
});

function npad(num){
    return (String(num).length < 2) ? '0' + num : num;
}

function realDate(d){
    var s = arguments.length > 1 ? arguments[1] : '.';
    return ($.type(d) == 'date') ? d : (new Date(d.split(s).reverse().join('/')));
}

function properDate(d){
    var s = arguments.length > 1 ? arguments[1] : '.';
    return ($.type(d) == 'date') ? [ d.getFullYear(), npad(1 + d.getMonth()), npad(d.getDate())].join('-') : d.split(s).reverse().join('-');
}

function OrderInst(options){
    var self = this, currencies = {1:'€', 2:'$'};

    this.canRecalc  = true;
    //this.fixedDates = options.fixedDates;
    this.loader  = window.loader || {on: $.noop, off: $.noop};
    this.apiPath = options.apiPath || '/ajax_order_odyssea.php';
    this.printWin = null;

    this.prepop = false;
    this.clickedbutton = '';

    this.orderData = {
        orderID: options.orderID || '',
        tmpID: '',
        editorID: options.editorID || '',
        from: options.from || '',
        till: options.till || '',
        rooms: [],
        bigRooms: [],
        nofly: options.fixedDates ? 0 : 1,
        nocheck: !options.jsCheck,
        flight: 0,
        xAgent: options.xAgent || '',
    };
    this.siteData = {
        siteID: options.siteID,
        allowDays: options.allowedDays || 0,
        allowDates: options.allowDates || {},
        currency: currencies[options.currency] || '€',
        min_nights: options.min_nights || 1,
        min_date: options.min_date || null,
        rooms: [],
        kids_max: options.kids_max || 1,
        no_price: options.no_price || false,
        freeBook: options.freeBook || 1,
        successMsg: options.successMsg || null
    };
	

    this._dayFilter = function(allowed){
        var ar = [0,0,0,0,0,0,0], allow = parseInt(allowed) ? $.map(ar, function(v, i){
            return allowed & Math.pow(2, i);
        }) : ar;

        return function(date){
            return [!!allow[date.getDay()], '', ''];
        };
    };

    this._dateFilter = function(allowed){
        return Array.isArray(allowed) ? function(date){
            return [(allowed.indexOf(date.toDB()) >= 0), '', ''];
        } : ((typeof allowed === 'string' && typeof window[allowed] === 'function') ? window[allowed] : function() {return false;});
    };

    this._counter = function(){
        var cnt = 0;
        return function(i){
            return (i === undefined) ? ++cnt : (cnt = i);
        }
    }();

    this.getRooms = function(){
        if (!this.orderData.from || !this.orderData.till)
            return;

        var self = this, tmp = realDate(this.orderData.from).diff(realDate(this.orderData.till));

        $('#tripNights').css('display', 'inline-block').html((tmp == 1) ? 'לילה אחד' : '' + tmp + ' לילות');

        return this.apiCall('get', {act: 'roomList', sid: this.siteData.siteID, from: this.orderData.from, till: this.orderData.till, nofly: this.orderData.nofly, flight:this.orderData.flight}).then(function(res){
            if (res.status === undefined || parseInt(res.status)){
                self.showError(res.error);
                self.loader.off();
                return false;
            }

            self.siteData.rooms = res.rooms;
            self.orderData.rooms.length || self.addRoom();

            tmp = $('#step2');

            tmp.children('.flight').remove();
            if (res.flight){
                tmp.find('.stepTitle').before(res.flight).end()
                    .find('input[name="flight"]').on('click', function(){
                        self.orderData.flight = this.value;
                        self.orderData.rooms.reduce(function(seq, room){
                            return seq.then(function(){
                                return room.reload();
                            });
                        }, Promise.resolve());
                    }).filter(':checked').trigger('click');
            }
            self.orderData.flight = res.flightID || 0;

            self.gotoStep(2);

            return self.orderData.rooms.reduce(function(seq, room){
                return seq.then(function(){
                    return room.reload();
                });
            }, Promise.resolve());
        }).fail(function(){
            self.showError('Cannot get rooms data. Please reload page and try again');
        });
    };

    this.addRoom = function(roomID, people, pans){
        var room = new OrderRoom(this);
        $('#roomsBlock').find('.addRoom').before(room.dom);
        this.orderData.rooms.push(room);

        /*if (roomID)
            room.load(roomID, people);
        return this;*/

        return roomID ? room.load(roomID, people, pans) : Promise.resolve(1);
    };

    this.loadRoom = function(index, roomID, people, pans){
        if (this.orderData.rooms[index])
            return this.orderData.rooms[index].load(roomID, people, pans);
        return Promise.resolve();
    };

    this.setDates = function(from, till){
        this.orderData.from = properDate(from);
        $('#orderFrom').datepicker('setDate', from);

        return $("#orderTill").datepicker('setDate', till).datepicker('option', 'onSelect')(till);
    };

    this.nextStep = function(){

        var data = this.orderData.rooms.length ? $.extend.apply({}, [{}].concat($.map(this.orderData.rooms, function(room){
                return room.selected();
            }))) : {};

        if (Object.keys(data).length){
            if(self.prepop && self.clickedbutton == 'order' && $('.preorderpop').length) {
                console.log('self.prepop')
                console.log(self.prepop)
                console.log('self.clickedbutton');
                console.log(self.clickedbutton);
                // $('.preorderpop').remove();
                return 1;
            }
            
            data.act = 'createOrder';
            data.nofly    = self.orderData.nofly;
            data.dateFrom = self.orderData.from;
            data.dateTill = self.orderData.till;
            data.flight   = self.orderData.flight;
            data.siteID   = self.siteData.siteID;
            data.xAgent   = self.orderData.xAgent;

            self.loader.on();
            self.apiCall('post', data).then(function(res){
				//debugger;
				$('.price_table').remove();
                var i = 0;

                if (res.status === undefined || parseInt(res.status))
                    self.showError(res.error);

                var cont = $('#step3');

                self._counter(0);
                self.orderData.bigRooms = [];
                cont.find('div.orderRoom').add('#hs').remove();
                cont.find('.orderPriceExplain').before(res.html);
				
				if(!$('.fWrap').length){
				  cont.find('.orderButton').before(res.flight_details);
				}else{
					$('.fWrap').remove();
					 cont.find('.orderButton').before(res.flight_details);
				
				}
	

                $('#roomsBlock').on('change', 'select', function(){
                    self.gotoStep(2);
                    //$('#roomsBlock').find('.nextStep .tab').on('click.step2', $.proxy(self.nextStep, self));
                }).find('.nextStep .tab').off('click.step2');

                $('#headGroup').empty();

                cont.find('.orderRoom').each(function(){
                    self.orderData.bigRooms.push(new OrderBigRoom(this, self));
                });

                cont.find('.sendOrder').off('click').on('click', function(){
                    self.loader.on();

                    var ok = true, split = parseInt($('#splitOrder').find('input').val()), agent = $('#agentForm');

                    $.each(self.orderData.bigRooms, function(i, r){
                        $.each(r.people, function(j, p){
                            return (ok = p.complete);
                        });
                        return ok;
                    });

                    if (ok && agent.length && agent.is(':visible')){        // all fields must be filled
                        ok = !agent.find('input').removeClass('error').filter(function(){
                            return !String(this.value).trim();
                        }).addClass('error').length;
                    }

                    if (ok || split){
                        var data = cont.closest('form').serialize();

                        self.apiCall('post', 'act=saveOrder&' + data).then(function(res){
                            if (res.status == undefined || parseInt(res.status))
                                return (self.showError(res.error || res._txt) || self.loader.off());

							ga && res.track && ga('send', 'event', 'createOrder', 'Button');
                            if (split)
                                swal({title:'תודה!' ,text:'קישור לביצוע ההזמנה נשלח לכל כתובות המייל שציינת.', type:'success'}).then(function(){
                                    window.location.href = res.redirect || '?siteID=' + res.sid + '&tab=12&sid=' + res.subID;
                                });
                            else if (self.siteData.successMsg)
                                swal($.extend({type:'success'}, self.siteData.successMsg)).then(function(){
                                    window.location.href = res.redirect || '?siteID=' + res.sid + '&tab=12&bid=' + res.bid;
                                });
                            else {
                              /*  swal('לקוח/ה יקר/ה', '\
הזמנתך בוצעה בהצלחה ותישלח לספקים בחו"ל<br />\
מיד עם מסירת פרטי אשראי מכל הנוסעים בהזמנה.<br /><br />\
הזמנה שבה חסרים פרטי אשראי של אחד מהנוסעים או יותר, <br />\
<b>תבוטל תוך 24 שעות מיום ביצועה</b><br /><br />\
תודה שבחרתם ' + options.credits.title + ' <br />\
מאחלים לכם חופשה מהנה <br />\
<b>מכל צוות ' + options.credits.title + '</b><br />\
' + options.credits.phone, 'success').then(function(){
                                    window.location.href = '?siteID=' + res.sid + '&tab=12&bid=' + res.bid;
                                });*/
							showCasPop(getOrderIcon,getOrderText);
							res.isComplete && (window.location.href = res.redirect || '?siteID=' + res.sid + '&tab=12&bid=' + res.bid);
                            }
                        });
                    } else {
                        self.showError('נא למלא את כל הפרטים לסיום הזמנה.');
                        self.loader.off();
                    }
                });

                cont.find('.sendToEmail').off('click').on('click', function(){
                    var empty = null;

                    $('#sendEmailBox').find('input').each(function(){
                        if (!$.trim(this.value)){
                            empty = $(this).siblings('.placeholder').text();
                            return false;
                        }
                    });

                    if (empty)
                        return self.showError('נא למלא ' + empty + ' !');

                    self.loader.on();
                    self.apiCall('post', 'act=priceOffer&' + cont.closest('form').serialize()).then(function(res){
                        self.loader.off();
                        if (res.status == undefined || parseInt(res.status))
                            self.showError(res.error || res._txt);
                        else{
							ga && res.track && ga('send', 'event', 'bid', 'Button');
                            swal({title:'בוצע!' ,text:'הצעת מחיר נשלחה לדוא"ל שלך!', type:'success'});
							}
                    }).fail(function(){
                        self.loader.off();
                        self.showError('השליחה נכשלה. נא לרענן את הדף ונשה שנית.');
                    });
                });

                cont.find('.printer').off('click').on('click', function(){
                    var hs = $('#hs').val();
                    self.loader.on();

                    self.printWin = window.open('about:blank', 'po_print_' + hs, 'height=800,width=1000,menubar=0,status=0');

                    self.apiCall('post', 'act=printout&' + cont.closest('form').serialize()).then(function(res){
                        self.loader.off();
                        if (res.status == undefined || parseInt(res.status))
                            self.showError(res.error || res._txt);
                        else
                            self.printWin.location.href = '/po_print.php?hs=' + hs;
                    }).fail(function(){
                        self.loader.off();
                        self.showError('השליחה נכשלה. נא לרענן את הדף ונשה שנית.');
                    });
                });

                self.trigger('priceChange');
                self.gotoStep(3);

                self.loader.off();
            });
        } else
            self.showError('יש לבחור חדר וכמות נוסעים');
    };

    this.loadSplit = function(token){
        var self = this;

        this.splitToken = token;

        this.apiCall('post', {act:'loadSplit', token:token}).then(function(res){
            var i = 0, headName = '', editable;

            if (res.status === undefined || parseInt(res.status))
                self.showError(res.error);

            var cont = $('#step3');

            self._counter(0);
            self.orderData.bigRooms = [];
            cont.find('div.orderRoom').remove();
            cont.find('.orderPriceExplain').before(res.html);

            $('#headGroup').empty();
            $('#globalRemark').html(res.remarks || '').parent()[res.remarks ? 'addClass' : 'removeClass']('hasText');

            self.orderData.from = res.from;
            self.orderData.till = res.till;

            cont.find('.orderRoom').each(function(){
                self.orderData.bigRooms.push(new OrderBigRoom(this, self));
            });

            editable = $.map(self.orderData.bigRooms, function(room){
                if (!headName){
                    var h = room.getHead();
                    headName = h ? h.name : '';
                }
                return room.getEditable();
            });

            editable.length && self.splitTitle('מסך מילוי פרטים להזמנה שיצר/ה ' + headName + '<br />עליך למלא את הפרטים עבור : ' + $.map(editable, function(p){
                return p.name;
            }).join(', '));

            cont.find('.sendOrder').text('שמור פרטים').off('click').on('click', function(){
                var data = cont.closest('form').serialize();

                self.loader.on();
                self.apiCall('post', 'act=saveSplit&stok=' + self.splitToken + '&' + data).then(function(res){
                    self.loader.off();
                    if (res.status == undefined || parseInt(res.status))
                        return self.showError(res.error || res._txt);

                    if (res.allData)        // all data filled
                       /* swal('לקוח/ה יקר/ה', '\
הזמנתך בוצעה בהצלחה ותישלח לספקים בחו"ל<br />\
מיד עם מסירת פרטי אשראי מכל הנוסעים בהזמנה.<br /><br />\
הזמנה שבה חסרים פרטי אשראי של אחד מהנוסעים או יותר, <br />\
<b>תבוטל תוך 24 שעות מיום ביצועה</b><br /><br />\
תודה שבחרתם ' + options.credits.title + ' <br />\
מאחלים לכם חופשה מהנה <br />\
<b>מכל צוות ' + options.credits.title + '</b><br />\
' + options.credits.phone, 'success').then(function(){
                            res.isComplete && (window.location.href = '?siteID=' + res.sid + '&tab=12&bid=' + res.bid);
                        });*/
						showCasPop(getOrderIcon,getOrderText);
						res.isComplete && (window.location.href = '?siteID=' + res.sid + '&tab=12&bid=' + res.bid);

						
                });
            });

            if (window.location.href.match(/&auth=[a-z0-9]+/)){
                cont.find('.reinvite').show().off('click').on('click', function(){
                    var mail = $(this).closest('.popUp').find('.formemail')[0], hs = $('#hs').val();
                    self.apiCall('post', {act:'reinvite', hs:hs, fd:mail.name, val:mail.value}).then(function(res){
                        if (res.status == undefined || parseInt(res.status))
                            return self.showError(res.error || res._txt);
                        swal('הזמנה נשלחה', 'הזמנה לעריכת פרטים נשלחה בהצלחה.', 'success');
                    });
                });
            }

            self.trigger('priceChange');

            //cont.find('.personLine').not('.disabled').first().find('.personData').click();
        });
    };

    this.splitTitle = function(title){
        (this.splitToken || this.orderData.tmpID) && $('#orderZone').children('h3').html(title);
    };

    this.trigger = function(key, value){
        var foo = 'price', tmp;
        switch(key){
            case 'roomRemove':
                if ((tmp = this.orderData.rooms.indexOf(value)) >= 0)
                    this.orderData.rooms.splice(tmp, 1);
                break;

            case 'priceChange':
                tmp = 0;
                $.each(this.orderData.bigRooms, function(i, r){
                    tmp += r[foo]();
                });

                this.siteData.no_price || $('#step3').find('.orderPriceTotal .price').text(this.siteData.currency + Math.round(tmp));
                break;
        }
    };

    this.showError = function(error){
       // swal({title:'שגיאה' ,text:error, type:'error'});
		showCasPop(errorIcon,errorText(error))
    };

    // with or without flight
    if (options.fixedDates && options.freeBook && !options.orderID){
        $('#flightSwitch').click(function(){
            self.orderData.nofly = this.checked ? 0 : 1;
            self.orderData.from = self.orderData.till = '';

            $('#orderZone').removeClass('step2 step3');

            $('#orderFrom').val('').datepicker('option', {
                beforeShowDay: self.orderData.nofly ? self._dayFilter(self.siteData.allowDays) : self._dateFilter(Object.keys(self.siteData.allowDates || {})),
                minDate: self.orderData.nofly ? self.siteData.min_date : (Object.keys(self.siteData.allowDates || {}).sort()[0] || '').split('-').reverse().join('.')
            });
            $('#orderTill').val('');
        });
        $('#flightSwitchCont').addClass('active');
    }

    $("#headGroup").on("change", function(){
        var lineID = $(this).find(':selected').data('js');
        $(".personLine").removeClass("headOrder");
        $("#person"+lineID).addClass("headOrder");
    });

    $('#orderFrom').not(':disabled').datepicker({
        beforeShowDay: this.orderData.nofly ? this._dayFilter(this.siteData.allowDays) : this._dateFilter(Object.keys(this.siteData.allowDates)),
        dateFormat: 'dd.mm.yy',
        minDate: this.orderData.nofly ? this.siteData.min_date : (Object.keys(this.siteData.allowDates).sort()[0] || '').split('-').reverse().join('.'),
        onSelect: function(date){
            self.orderData.from = properDate(date);

            var back = self.orderData.nofly ? null : self.siteData.allowDates[self.orderData.from], dp = $("#orderTill");

            if (back && typeof back === 'boolean'){
                self.loader.on();
                self.apiCall('post', {act:'backFlights', forth:self.orderData.from, sid:self.siteData.siteID}).then(function(res){
                    if (!res || res.status === undefined || parseInt(res.status) || !res.list || !res.list.length)
                        return swal({title:'סליחה!' ,text:'אין חבילות לתאריך זה', type:'error'}).then(function(){self.loader.off();});

                    self.siteData.allowDates[self.orderData.from] = res.list;       // updating back dates

                    if (res.list.length == 1){
                        var back = res.list[0].flipDate('.');
                        dp.datepicker('option', dp.datepicker('option', 'beforeShow')()).datepicker('setDate', back).datepicker('option', 'onSelect')(back);
                    }
                    else
                        setTimeout(function(){ dp.val('').datepicker('show'); }, 100);

                    self.loader.off();
                });
            }
            else if (back && Array.isArray(back) && back.length == 1){
                back = back[0].flipDate('.');
                dp.datepicker('option', dp.datepicker('option', 'beforeShow')()).datepicker('setDate', back).datepicker('option', 'onSelect')(back);
            }
            else
                setTimeout(function(){ dp.val('').datepicker('show'); }, 100);
        }
    });

    $('#orderTill').not(':disabled').datepicker({
        dateFormat: 'dd.mm.yy',
        //minDate: this.siteData.min_date,
        beforeShow: function(){
            var from = $('#orderFrom').val(), min = self.orderData.nofly ? realDate(from).add(self.siteData.min_nights) : realDate(from);
            return from ? {minDate: min, beforeShowDay: self.orderData.nofly ? null : self._dateFilter(self.siteData.allowDates[self.orderData.from])} : {minDate: (new Date()), beforeShowDay: self._dayFilter(0)};
        },
        onSelect: function(date){
            self.orderData.till = properDate(date);
            return self.getRooms();
        }
    });

    $('#roomsBlock').find('.addRoom').click($.proxy(this.addRoom, this))
        .end().find('.nextStep .tab').on('click.step2', $.proxy(this.nextStep, this))
        .on('click', function(){
            var a = (this.id == 'order') ? ['prop', 'order'] : ['order', 'prop'];
self.clickedbutton = this.id;
            $('.preorderpop').remove();
            if(!self.prepop && this.id == 'order') {
                let _pophtml = `
        <div class="preorderpop" style="display:none">
        <link href="/css/preOrderPop.css"  rel="stylesheet" type="text/css" />
            <div class="po-pop-cont">
                <div class="po-pop-pic"><img src="/webimages/preOrderPop/top.jpg" alt="" /></div>
                <div class="po-pop-bg">
                    <div class="po-pop-txt">
                        <div class="po-pop-top-txt">
                            <b>היי לך,</b><br>
        לחיצה על המשך תאפשר לך לבדוק מחירי חופשות, לשלוח הצעות מחיר באימייל  ואף לבצע הזמנה
                        </div>
        במידה ובחרת לבצע הזמנה חשוב לנו לציין שבשל העובדה שאין אישור מיידי לחופשות המוצעות באתר, בסיום ביצוע ההזמנה תוחזק מסגרת בכרטיס האשראי, לטובת שליחת ההזמנה לספקים השונים<br>
                        <b>ולא יתבצע חיוב בפועל</b>
                        <div class="po-pop-frame">
                            <div class="po-pop-frame-pic"><img src="/webimages/preOrderPop/frame_top.png" alt="" /></div>
                            <div class="po-pop-frame-bg">חיוב האשראי יתבצע אך ורק בתנאי שההזמנה תאושר ע"י כל הספקים</div>
                            <div class="po-pop-frame-pic"><img src="/webimages/preOrderPop/frame_btm.png" alt="" /></div>
                        </div>
        במידה וההזמנה לא תאושר, צוות החברה יצור איתך קשר טלפוני להצעת חלופות אפשריות
                        <div class="po-pop-graphic"><img src="/webimages/preOrderPop/graphic.png" alt="" /></div>
                        <b>תודה שבחרת פינגווין<br>
        נשמח לעמוד לרשותך גם בטלפון<br>
                            04-8557722
                        </b>
                        <div>
                            <div class="po-pop-btn" onclick="orderMan.clickedbutton = 'orderextra';orderMan.nextStep();$('.preorderpop').remove();$('#orderZone').removeClass('prop').addClass('order');">
                                <div>המשך</div>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="po-pop-pic"><img src="/webimages/preOrderPop/btm.jpg" alt="" /></div>
            </div>
        </div>`;
        $(_pophtml).appendTo('body');
        $('.preorderpop').fadeIn('fast');
        self.prepop = true;
        return 1;
                }
            
            $("#orderZone").removeClass(a[0]).addClass(a[1]);
        });


    $("#splitOrder").click(function() {
        var inp = $(this).find('input')[0];

        $("#orderZone")[parseInt(inp.value) ? 'removeClass' : 'addClass']("smartForm");
        inp.value = (parseInt(inp.value) + 1) % 2;
    });

    $('input', '#agentForm').on('blur', function(){
        String(this.value).trim() ? $(this).removeClass('error') : $(this).addClass('error');
    });

    if (this.siteData.no_price)     // clubmed
        $('#step3').find('.orderPriceTotal .price').html('<img src="/images/phone_price_white.png" alt="" border="0" />');

    // if ($(window).width() < 767)
    //     $('#splitOrder').trigger('click');

    console.log('Поехали!');
}

$.extend(OrderInst.prototype, {
    apiCall: function(method, params){
        return $[method.toLowerCase()](this.apiPath, params);
    },

    ajaxRoomPrice: function(roomID, pax, pansion){
        var self = this;

        this.canRecalc && this.loader.on();
        return this.canRecalc ? this.apiCall('get', {act:'roomPrice', sid: this.siteData.siteID, dateFrom: this.orderData.from, dateTill: this.orderData.till, nofly: this.orderData.nofly, flight: this.orderData.flight, roomID: roomID, adults: pax.adults || 0, kids: pax.kids || [], pansion: pansion}).then(function(res){
            self.loader.off();
            $('#roomsBlock').find('.nextStep').css('visibility', (res.price >= 0 || self.siteData.no_price) ? 'visible' : 'hidden');
            return (res.price === undefined) ? -1 : res.price;
        }).fail(function(){
            self.loader.off();
            $('#roomsBlock').find('.nextStep').hide();
            swal('Connection error', 'Cannot connect to server', 'error');
            return -1;
        }) : Promise.resolve(-1);
    },

    gotoStep: function(step){
        var zone = $('#orderZone'), co = zone.attr('class'), cn = co.replace(/\s+step\d/g, '') + ' step' + step;
        (co == cn) || zone.attr('class', cn);

        if (step == 2)
            $('#roomsBlock').find('.nextStep .tab').off('click.step2').on('click.step2', $.proxy(this.nextStep, this));
        else if (step == 3)
            $('#flightSwitch').prop('disabled', true);
    },

    checkAge: function(pdata){
        var self = this, bd = realDate(pdata.birthday, '/'), sd = realDate(this.orderData.from),
            age = sd.getFullYear() - bd.getFullYear() - ((sd.getMonth() < bd.getMonth() || (sd.getMonth() == bd.getMonth() && sd.getDate() < bd.getDate())) ? 1 : 0);

        if (($.type(pdata.range) == 'array' && age >= pdata.range[0] && age <= pdata.range[1]) || parseInt(pdata.range) == age){// if allowed age
             swal({title:'שים לב!' ,text:'לא ניתן יהיה לשנות את תאריכי הלידה של הילדים בשלב הבא.', type:'info'});
			 return;

		}

        swal({
            title:'שים לב !',
            html: "תאריך הלידה שבחרת אינו תואם את הגיל המוגדר.<br />שינוי גיל עלול לגרום לשינוי מחיר החבילה.<br />לתקן את הגיל לפי תאריך לידה?",
            type: 'warning',
            showCancelButton:true,
            cancelButtonText: 'לא',
            confirmButtonText: 'כן'
        }).then(function(){
            self.loader.on();
            self.apiCall('post', {act:'updateAge', hs:$('#hs').val(), rin:pdata.rin, pin:pdata.pin, bd:pdata.birthday}).then(function(res){
                if (res.status === undefined || parseInt(res.status)){
                    self.loader.off();
                    throw new Error(res._txt);
                }
                pdata.callback(res);
                self.loader.off();
            });
        }, function(){
            pdata.callback({act:'cancel'});
        });
    },

    changePans: function(pans){
        $.each(this.orderData.rooms, function(i, room){
            room.setPansion(pans);
        });

        $.each(this.siteData.rooms, function(i, room){
            room.defaultPan = pans;
        });

    }
});

function OrderRoom(order){
    var self = this;

    this.order = order;
    this.index = this._genIndex();
    this.price = 0;
    this.has_price = !order.siteData.no_price;
    this.cSign = order.siteData.currency;
    this.dom   = $('<div class="roomLine">' +
        '<div class="removeRoom"></div>' +
        '<div class="rgtCont"><div class="section type"><label>סוג הדירה / החדר</label><select id="room'+this.index+'" name="roomType[' + this.index + ']" class="roomSelect">' + this._genRooms(order.siteData.rooms) + '</select></div>' +
        '<div class="section limit"><span>בחדר זה</span><span class="limitroom"></span></div>' +
        '<div class="section pension"><label>סוג אירוח</label><select name="pansion[' + this.index + ']" id="vpan' + this.index + '" class="panSelect"></select></div>' +
        '<div class="section travels"><select name="adults[' + this.index + ']" id="people'+this.index+'_0" class="paxSelect"><option value="0">מס מבוגרים</option></select></div></div>' +
        '<div class="bigSectionKids"></div>' +
        '<div class="section price showed"><label>עלות</label><span></span></div>' +
        '</div>');

    this.selectedRoom = null;


    this.dom.find('select.roomSelect').on('change', function(){
        var rid = parseInt(this.value), room = self.order.siteData.rooms[rid], line, tmp, kids;

        if (!room){
            self.dom.find(".section.pension, .section.limit, .section.travels, .bigSectionKids").css('display', 'none').find('select').prop('selectedIndex', 0);
            self.dom.find('.section.kids_ok').removeClass('kids_ok kid_show');
            self.selectedRoom = null;

            return self._setPrice(-1);
        }
        else
            self.selectedRoom = room;

        line = self.dom.find(".section.pension, .section.limit, .section.travels, .bigSectionKids").css('display', 'inline-block');

        tmp = line.filter('.pension').find('select');
        tmp[0].innerHTML = self._genPansion(room.pans, tmp.val() || room.defaultPan);

        line.filter('.limit').find('.limitroom').html((room.people_min == room.people_max) ? (room.people_min == 1 ? 'אורח אחד' : '' + room.people_min + ' אורחים') : '' + room.people_min + ' - ' + room.people_max + ' אורחים');

        tmp = line.filter('.travels').find('select');
        tmp[0].innerHTML = self._genPeople(1, room.people_max, tmp.val());
        tmp.trigger('change');

        tmp = line.filter('.bigSectionKids');
        kids = tmp.find('.kid_ok select').map((i, e) => (parseInt(e.value) >= 0) ? e.value : []).get();

        tmp.html(self._genKids(self.index, self.selectedRoom.people_max)).find('.section.kids select').off('change').on('change', function(){ self._getPrice(); });
        if (self.selectedRoom){
            var val, lim;
            val = parseInt($('select[name="adults[' + self.index + ']').val());
            lim = Math.max(self.selectedRoom.people_max - val, 0);

            tmp.find('.section.kids')
                .slice(0, lim).addClass('kid_ok').end()
                .slice(lim).removeClass('kid_ok kid_show').find('select').prop('selectedIndex', 0);

            if (kids.length){
                let sk = tmp.find('.kid_ok');
                kids.reduce((last, val, i) => sk[i] ? $(sk[i]).addClass('kid_show').find('select').val(val).end() : last, $()).addClass('lastVisible');
            }
        }

    });

    this.dom.find('select[name="adults[' + self.index + ']"]').on('change', function(){
        var val, lim;

        if (self.selectedRoom){
            val = parseInt(this.value);
            lim = Math.max(self.selectedRoom.people_max - val, 0);

            self.dom.find('.section.kids')
                .slice(0, lim).addClass('kid_ok').end()
                .slice(lim).removeClass('kid_ok kid_show lastVisible').find('select').prop('selectedIndex', 0);
        }

        self._getPrice();
    });

    //this.dom.find('.section.kids select').on('change', function(){ self._getPrice(); });

    this.dom.find('.section.pension select').on('change', function(){ order.changePans(this.value); });

    this.dom.find('.removeRoom').click(function(){
        $(self.dom).remove();
        order.trigger('roomRemove', self);
    });

    this.dom.find('.bigSectionKids')
        .on('click', '.kidAdd', function(){
          //$('.hotelOrder .orderZone .step .kids_ages').css({'display':'inline-block'}); // comment
            self.dom.find('.kid_ok:not(.kid_show)').first().addClass('kid_show');
            self.dom.find('.section.kids').removeClass('lastVisible');
            self.dom.find('.kid_ok.kid_show').last().addClass('lastVisible');
        })
        .on('click', '.kidRemove', function(){
            self.dom.find('.kid_ok.kid_show').last().removeClass('kid_show').find('select').prop('selectedIndex', 0).trigger('change');
            self.dom.find('.section.kids').removeClass('lastVisible');
            self.dom.find('.kid_ok.kid_show').last().addClass('lastVisible');
        });
}

$.extend(OrderRoom.prototype, {
    _genIndex: function(){
        var i = 0;
        return function(){
            return ++i;
        };
    }(),
	_roomSort: function(arr){
		return $.map(arr,function(e){return e;}).sort(function(a,b){
			return a.showOrder - b.showOrder;
		});
	},
    _genPax: function(){
        var pax = {adults:0, kids:[]};
        this.dom.find('select.paxSelect').each(function(){
            var name = this.name.replace(/\[\d+\]/g, ''), val = parseInt(this.value);
            if (val >= 0)
                name.match(/\[\]$/) ? pax[name.substr(0, name.length - 2)].push(val) : (pax[name] = val);
        });
        return pax;
    },

    _genRooms: function(rooms, selected){
        return '<option value="0">בחר חדר</option>' + $.map(this._roomSort(rooms), function(room){
            return '<option value="' + room.roomID + '"' + ((selected == room.roomID) ? ' selected="selected"' : '') + '>' + room.roomName + '</option>';
        }).join('');
    },

    _genPeople: function(min, max, selected){
        var res = '<option value="0">מס מבוגרים</option>', i;
        for(i = min; i <= max; ++i)
            res += '<option value="' + i + '"' + ((selected == i) ? ' selected="selected"' : '') + '>' + ((i == 1) ? 'מבוגר אחד' : i + ' מבוגרים') + '</option>';
        return res;
    },

    _genPansion: function(pans, selected){
        var sleep = ['','לינה בלבד','ארוחת בוקר','חצי פנסיון','','חצי פנסיון + שתיה','פנסיון מלא','הכל כלול','ארוחת ערב','באגט וקרואסון','באגט וקרואסון + ארוחת ערב','','אולטרה הכל כלול', '', '', 'חצי פנסיון + ארוחת צהרים קלה'], seder = [1,9,2,8,10,3,5,6,7,12,15];
        return seder.reduce(function(res, ind){
            return (pans.indexOf(ind) >= 0) ? res + '<option value="' + ind + '"' + ((selected == ind) ? ' selected="selected"' : '') + '>' + sleep[ind] + '</option>' : res;
        }, '');
    },

    _getPrice: function(){
        var self = this, roomID = this.dom.find('select.roomSelect').val(), pans = this.dom.find('.pension select').val(), pax = this._genPax();

        return (roomID && pans && (pax.adults || pax.kids.length)) ? this.order.ajaxRoomPrice(roomID, pax, pans).then(function(price){
            //return self._setPrice(price.price);
            return self._setPrice((typeof price == 'object') ? price.price : price);
        }) : this._setPrice(-1);
    },

    _setPrice: function(price){
        this.price = parseFloat(price);
        this.dom.find('.section.price span').html(this.price ? ((this.price >= 0) ? this.cSign + Math.round(this.price) : '') : (this.has_price ? '' : '<img src="/images/phone_price.png" alt="" border="0" />'));
        return Promise.resolve(price);
    },

    load: function(roomID, people, pans){
        this.order.canRecalc = false;

        this.dom.find('select.roomSelect').val(roomID).trigger('change');
        if (people && people.adults)
            this.dom.find('.travels select').val(people.adults).trigger('change');
        if (people && people.kids && people.kids.length){
            var tmp = this.dom.find('.kids.kid_ok').slice(0, people.kids.length).addClass('kid_show').find('select');
            tmp.length && $.each(people.kids, function(i, age){
                tmp[i] && (tmp[i].value = age);
            });
        }
        if (pans)
            this.dom.find('select.panSelect').val(pans);

        this.order.canRecalc = true;
        return this._getPrice();
    },

    reload: function(){
        var select = this.dom.find('select')[0], rval = select.value, tmp;

        select.innerHTML = this._genRooms(this.order.siteData.rooms, rval);
        return $(select).triggerHandler('change');
    },

    selected: function(){
        if (this.price > 0 || (this.price == 0 && !this.has_price)){
            var res = {}, reg = /\[\]$/, tmp;

            this.dom.find('select').map(function(){
                if (parseInt(this.value) >= 0)
                    if (reg.test(this.name)){
                        tmp = this.name.substr(0, this.name.length - 2);
                        res[tmp] ? res[tmp].push(this.value) : (res[tmp] = [this.value]);
                    }
                    else
                        res[this.name] = this.value;
            });

            return res;
        }
        return null;
    },

    _genKidsOptions:function(min, max, selected){
        var res='<option value="-1">בחר גיל</option>';
        for(var i = min; i <= max; ++i)
            res += '<option value="' + i + '" ' + ((i == selected) ? 'selected="selected"' : '') + '>' + ('גיל ' + i) + '</option>';
        return res;
    },

    _genKids: function(index,max=4){
        var self = this;
        var res = '';
        for(var i = 1; i <= max; i++){

            res += '<div class="section kids" data-index="'+index+'" data-kid="'+i+'"><label>ילד '+i+'</label> <div class="kid"><div class="kidRemove" id="kidRemove'+index+'_'+i+'" >ילד</div><div class="kidHide" id="kid'+index+'_'+i+'"><div class="kidTitle">ילד '+i+'</div><select name="kids['+index+'][]" id="people'+index+'_'+i+'"  class="select paxSelect" >'+self._genKidsOptions(0, this.order.siteData.kids_max, -1)+'</select></div>' +
                '<div class="kidNo" id="kidNo'+index+'_'+i+'"></div><div class="kidAdd" id="kidAdd'+index+'_'+i+'">ילד</div></div></div>';
        }
        return res;
    },

    setPansion: function(pan){
        this.dom.find('.section.pension select').val(pan);
        this._getPrice();
    }
});


function OrderPerson(container, room, roomInd, personInd, globalInd, isSplit){
    var self = this, tmp;

    this.cont      = $(container);
    this.roomIndex = roomInd;
    this.globIndex = globalInd;
    this.index     = personInd;
    this.room      = room;

    this.elemIndex = '[' + roomInd + '][' + personInd + ']';
    this.jsIndex   = '' + roomInd + '_' + personInd;

    tmp = this.cont.children('.price').html();

    this.namePlaces = ['.personData > .personindex'];
    this.stopper    = [];
    this.currency   = tmp.substr(0, 1);
    this.price      = room.has_price ? parseFloat(tmp.substr(1)) : 0;

    this.complete   = false;

    this.type = this.cont.data('type');

    // line events
    /*this.cont.find(".emailsend").on('blur', function(){
        self.cont.find(".formemail").val(this.value);
    });

    // setting all line closers
    this.cont.find('.closer').click(function(){
        $(this).closest('.popUp').removeClass('open');
        //self._allowScroll($(this).data('div'));
    });*/

    this.cont.find('input.double').on('change', function(){
        var d = $(this).data('double'), dm = $(this).data('doublemobile');
        $(d ? '#' + d : '').add(dm ? '#' + dm : '').val(this.value);
    });

    /*this.cont.find('input.double').on('change', function(){
        var d = $(this).data('doublemobile');
        d && $('#' + d).val(this.value);
    });*/

    tmp = this.cont.find(".extra").click(function(){
        var pop = $(this).data('OrderPop');
        pop && pop.open();
    });

    isSplit && tmp.not(':has(>.details)').off('click').on('click', function(){
        self.openPop(self.cont.find('.content.dataform').parent());
    });


    // multi-line events
    this.cont.find(".head:not(.disabled)").click(function(){
        $(".personLine").removeClass("headOrder");
        self.cont.addClass("headOrder");
        $("#headGroup").val(self.globIndex);
    });

    this.cont.find(".personData, .editdata").click(function(){
        self.openPop(self.cont.find('.content.dataform').parent());
    });

    // personal data popup
    tmp = this.cont.find('.content.dataform');

    tmp.find('.moreform').click(function(){
        $(this.parentNode).toggleClass('active');
    });

    tmp.find('#pay' + this.jsIndex).on("change", function(){
        if($(this).val() == 1)
            $('#payTypeSelect' + self.jsIndex).addClass("isPayment");
        else
            $('#payTypeSelect' + self.jsIndex).removeClass("isPayment");
    }).change();

    tmp.find('input:not(.submit), select').on("focusout", function(){
        var inp = $(this), data = inp.data();

        if (self.isValidType(this.value, data.type) && (!data.minLen || $.trim(this.value).length >= data.minLen)){
            inp.closest('.section').removeClass('error');
        } else {
            inp.closest('.section').addClass('error');
        }
    });

    tmp.find('input.submit, .closer').click(function(){
        var valid = true, btn = $(this), pop = btn.closest('.popUp'), sel;
        var mobileSend = false;

        if($(window).width() <  767 && !self.cont.find('.pData.active').length){
            mobileSend = true;
        }


        self.cont.find('.content.dataform input').each(function(){
            var inp = $(this), data = inp.data();

            if (this.type == 'checkbox'){
                inp[(data.optional || this.checked) ? 'removeClass' : 'addClass']('failed');
                valid = valid && (data.optional || this.checked);
            }
            else if (self.isValidType(this.value, data.type) && (!data.minLen || $.trim(this.value).length >= data.minLen)){
                inp.closest('.section').removeClass('error');
            } else {
                inp.closest('.section').addClass('error');
                valid = false;
            }
        });

        sel = $('#gender' + self.jsIndex);
        if (!parseInt(sel.val())){
            sel.parent().addClass('error');
            valid = false;
        } else
            sel.parent().removeClass('error');

        sel = $('#pay' + self.jsIndex);
        if (!parseInt(sel.val())){
            sel.parent().addClass('error');
            valid = false;
        }
        else if (parseInt(sel.val()) == 1){
            sel.parent().removeClass('error');

            sel = $('#payType' + self.jsIndex);
            if (!parseInt(sel.val())){
                sel.parent().addClass('error');
                valid = false;
            } else
                sel.parent().removeClass('error');
        }
        else
            sel.parent().removeClass('error');

        if (btn.hasClass('closer')){
            if(valid || !self.room.needCheck() || !isSplit)
                self.closePop(pop);
            else
                swal({
                    title:'לקוח/ה יקר/ה',
                    html: "לא כל הפרטים הנדרשים מולאו בהצלחה.<br />האם ברצונך לצאת מטופס זה?",
                    type: 'warning',
                    showCancelButton:true,
                    cancelButtonText: 'לא',
                    confirmButtonText: 'כן'
                }).then(function(){
                    self.closePop(pop);
                }, $.noop);
        }
        else if(valid || !self.room.needCheck() || mobileSend){
            self.closePop(pop);		
        }
        else if (!valid)
            swal('לקוח/ה יקר/ה', 'לא כל הפרטים הנדרשים מולאו בהצלחה<br />אנא בדוק שוב והשלם את הפרטים החסרים', 'error').then(function(){
                var pdata = pop.find('.pData');
                //var scroller = self.cont.find('.content.dataform .pData').scrollTop() + self.cont.find('.content.dataform .pData .error').first().focus().position().top;
                pdata.animate({scrollTop: pdata.scrollTop() + pdata.find('.error').position().top}, "slow");
            });

        var fname = $.trim($('#fname' + self.jsIndex).val()), lname = $.trim($('#lname' + self.jsIndex).val()), name = (fname || lname) ? $.trim(fname + ' ' + lname) : pop.find('.personindex').data('passenger');
        if (self.namePlaces.length)
            self.cont.find(self.namePlaces.join()).html(name).parent()[(fname || lname) ? 'addClass' : 'removeClass']('wname');

        if (self.complete = valid){
            self.cont.removeClass('nocompleted').addClass('completed');
        } else {
            self.cont.removeClass('completed').addClass('nocompleted');
        }

        if (isSplit && (self.complete = valid || !self.room.needCheck()) && btn.hasClass('submit'))
            $("#step3").find('.orderButton > .sendOrder').click();
    });


    //tmp.find("input.firstName, input.lastName").on('blur', $.proxy(this._changeName, this));
    this.cont.find('input.datepicker').datepicker({
        changeMonth: true,
        changeYear: true,
        yearRange: "1930:+0",
        defaultDate: '-25y',
        onSelect: function(date){
            if (date){
                var inp = $(this);

                $(this.parentNode).removeClass('error');
                self.room.trigger('ageChange', {
                    birthday: date,
                    range: inp.data('range'),
                    rin: self.roomIndex,
                    pin: self.index,
                    person: self,
                    callback: function(result){
                        var prices = result.prices, tmp;

                        switch(result.act){
                            case 'prices':
                                if (prices.total)
                                    self.cont.data('basePrice', parseFloat(prices.total));
                                if (prices.title){
                                    tmp = self.cont.find('.personindex');

                                    tmp.attr('data-passenger', prices.title);
                                    tmp.parent().hasClass('wname') || tmp.text(prices.title);
                                }
                                if (prices.cancel)
                                    $('#ski_pass' + self.jsIndex + '_0').data('price', parseFloat(prices.cancel));
                                if (prices.pass)
                                    $('#ski_pass' + self.jsIndex + '_1').data('price', parseFloat(prices.pass));
                                if (prices.pass2)
                                    $('#ski_pass' + self.jsIndex + '_2').data('price', parseFloat(prices.pass2));

                                result.age && inp.data('range', result.age);

                                self.renewPrice();
                                break;

                            case 'cancel':
                                inp.addClass('error').val('');
                                break;
                        }
                    }
                });
            }
        }
    });

    // type pop
    tmp = new OrderPop({
        pop:      this.cont.find('.content.typeform').parent(),
        main:     true,
        person:   this,
        onSubmit: function(data){
            if (data.selected && data.selected.value){
                //var days = (new Date(data.till.split('.').reverse().join('/'))).diff(new Date(data.from.split('.').reverse().join('/')));
                self.cont.find(".extra.type").addClass("active").attr('data-val', data.selected.value).children('.details').html('<p>'+$(data.selected).data('title')+'</p>');
                    //.children('.details').html('<p>הדרכה - ' + (days > 1 ? days + ' ימים' : 'יום אחד') + '</p><p>' + data.from + ' - ' + data.till + '</p>')
                    //.siblings('.addPrice').html('€' + $(data.selected).data('price'));

                self.cont.attr('data-type', data.selected.value);
                self.type = data.selected.value;

                self._updateSkiEquipment( self.cont.find('.equipCheck:checked').val() ? self.cont.find('.equipCheck:checked') : 0);
                self._updateGuide( self.cont.find('.guideCheck:checked').val() ? self.cont.find('.guideCheck:checked') : 0 );
                self._updateSkiEquipmentDesc();
            } else {
                self.cont.find(".extra.type").removeClass("active").attr('data-val', '').children('.details').html('<p>ללא גלישה</p>');
                self.cont.attr('data-type', '');
                self.type = '';

                var realPrice = self.room.has_price;
                self.room.has_price = false;   // hack to stop recalculating price

                self.cont.find(".extra.bikes, .extra.guide, .extra.ski").each(function(){
                    var pop = $(this).data('OrderPop');
                    pop && pop.cancel();
                });
                self.room.has_price = realPrice;    // restoring real value to recalculate price if needed
            }
            self.renewPrice();
        }
    });
    this.cont.find(".extra.type").data('OrderPop', tmp);

    // equip popup
    tmp = new OrderPop({
        pop:      this.cont.find('.content.equipform').parent(),
        main:     false,
        person:   this,
        onSelect: function(data){
            var eqID = $(data.target).data('extra');
            if(eqID){
                self.cont.find('.equipSize').hide();
                self.cont.find("#"+eqID).show().find('input').first().prop('checked', true);
            }
        },
        onDateChange: function(from, till, days){
            this.cont.find('.dnum').text(days > 2 ? '-' + this.hebDays(days) : this.hebDays(days));
        },
        onSubmit: function(data){
            if (data.selected && parseInt(data.selected.value)){
                self.cont.find(".extra.bikes").addClass("active")
                    .children('.details').html('<p>' + (data.selected.labels ? data.selected.labels[0].innerText : $(data.selected).siblings('label').text()) + '</p><p class="equipmentType"></p><p class="equipmentSubType"></p>');
                    //.siblings('.addPrice').html('€' + $(data.selected).data('price'));


                self._updateSkiEquipment(data.selected);

            } else
                self.cont.find(".extra.bikes").removeClass("active").children('.details').html('<p>ללא ציוד</p>');
            self.renewPrice();
        }
    });
    this.cont.find(".extra.bikes").data('OrderPop', tmp);


    /* GUIDE FUNCS */
    tmp = new OrderPop({
        pop:      this.cont.find('.content.trainform').parent(),
        main:     false,
        person:   this,
        onSubmit: function(data){

            if (data.selected && parseInt(data.selected.value)){
                //var days = (new Date(data.till.split('.').reverse().join('/'))).diff(new Date(data.from.split('.').reverse().join('/')));
                self.cont.find(".extra.guide").addClass("active").attr('data-guide', data.selected.value)
                    .children('.details').html('<p class="guideTitle"></p><p class="guideDesc"></p>');
                    //.siblings('.addPrice').html(self.currency + $(data.selected).data('price'));


                self._updateGuide(data.selected);

            } else
                self.cont.find(".extra.guide").removeClass("active").attr('data-guide', '').children('.details').html('<p>ללא הדרכה</p>');
            self.renewPrice();
        }
    });
    this.cont.find(".extra.guide").data('OrderPop', tmp);


    /* SKI PASS FUNCS */
    tmp = new OrderPop({
        pop:      this.cont.find('.content.skiform').parent(),
        main:     false,
        person:   this,
        onSubmit: function(data){
            if (data.selected && parseInt(data.selected.value)){
                //var days = (new Date(data.till.split('.').reverse().join('/'))).diff(new Date(data.from.split('.').reverse().join('/')));
                self.cont.find(".extra.ski").addClass("active")
                    .attr('data-val', data.selected.value)
                    .children('.details').html('<p>'+$(data.selected).data('title')+'</p>');
                    //.siblings('.addPrice').html(self.currency + $(data.selected).data('price'));
            } else
                self.cont.find(".extra.ski").removeClass("active").attr('data-val', '').children('.details').html('<p>ללא סקי פס</p>');
            self.renewPrice();
        }
    });
    this.cont.find(".extra.ski").data('OrderPop', tmp);

    $('#headGroup').append('<option data-js="'+ this.jsIndex +'" value="' + globalInd + '">נוסע ' + globalInd + '</option>');

    this.extend && this.extend();
}

$.extend(OrderPerson.prototype, {
    _updateGuide:function(input){
       if(!input)
           return false;

       var self = this, inp = $(input), data = inp.data(), npr = data[self.type + 'Price'], value = parseInt(inp.val());

        // if no price, but has value (aka not "empty" option) - cancel selection
       if (!npr && value)
           //return this._updateGuide(inp.closest('.popUp').find('.noneSelect').prop('checked', true));
           return window.setTimeout(function(){
               inp.closest('.popUp').find('.noneSelect').prop('checked', true).end().find('input.submit').click();
           }, 100);

       self.cont.find('.guideTitle').text(data.title);
       self.cont.find('.guideDesc').text(self.type == 'snow' ? data.snowDesc : data.skiDesc);
       npr && inp.data('price', npr);
    },
    _updateSkiEquipmentDesc:function(){
      var self = this;

        self.cont.find('.selectSubSize input').each(function(){
            var obj = $(this).data();
            if(obj.skiTitle || obj.snowTitle)
                $(this).next('label').text( (self.type == 'snow' ? obj.snowTitle : obj.skiTitle) );
        });
    },
    _updateSkiEquipment: function(data){
        if(!data)
            return false;

        var self = this;
        var eqID = $(data).data('extra');
        var eqOption = $('#'+eqID).find('input:checked');
        var eqTitle, eqPrice;
        eqTitle = eqOption.data('title');
        eqPrice = eqOption.data('skiPrice');

        if(self.type=='snow'){
            if(eqOption.data('snowTitle'))
                eqTitle = eqOption.data('snowTitle');

            if(eqOption.data('snowPrice'))
                eqPrice = eqOption.data('snowPrice');
        }

        if(self.type=='ski' && eqOption.data('skiTitle')){
            eqTitle = eqOption.data('skiTitle');

        }
        $(data).data('price', eqPrice);

        //self.cont.find('.equipmentType').attr('data-ski-desc', $(data).data('ski-desc')).attr('data-snow-desc', $(data).data('snow-desc'));
        //self.cont.find('.equipmentSubType').text(eqTitle);
        self.cont.find('.equipmentType').attr('data-ski-desc', eqTitle).attr('data-snow-desc', eqTitle);
        self.cont.find('.extra.bikes').attr('data-title', eqTitle);
        self.cont.find('.extra.bikes .addPrice').html('€'+ eqPrice );

    },
    _changeName: function(){
        var name = $.trim(this.cont.find('input.firstName, input.lastName').map(function(){
            return this.value;
        }).get().join(' '));

        this.cont.find('.personbtn').html(name || 'לחצו למילוי פרטים');
        this.cont.find(this.namePlaces.join(',')).html(name || this.cont.find('.personindex').data('passenger'));
    },

    /*_stopScroll: function(id){
        this.stopper[id] = 1;
        $('body').addClass('noscrollpop');
    },

    _allowScroll: function(id){
        if (this.stopper[id]){
            delete(this.stopper[id]);
            Object.keys(this.stopper).length || $('body').removeClass('noscrollpop');
        }
    },*/

    details: function(){
        var name = $.trim(this.cont.find('.personindex').text()), disabled = this.cont.hasClass('disabled'), complete = this.cont.hasClass('completed'), isHead = this.cont.hasClass('headOrder');

        return {name:name, disabled:disabled, complete:complete, isHead:isHead};
    },

    openPop: function(pop){
        if (pop.length){
            pop.addClass("open");
            this.stopper.push(pop[0]);
            $('body').addClass('noscrollpop');
        }
    },

    closePop: function(pop){
        var e = this.stopper.indexOf($(pop)[0]);

        pop.removeClass("open");
        if (e >= 0 || !this.stopper.length)
            this.stopper.splice(e, 1);
        this.stopper.length || $('body').removeClass('noscrollpop');
    },

    closeAll: function(){
        this.cont.find('.popUp').removeClass('open');
        $('body').removeClass('noscrollpop');
        this.stopper.length = 0;
    },

    renewPrice: function(tempPrice){
        if (this.room.has_price){
            var price = parseFloat(this.cont.data('basePrice'));

            this.cont.find('input[type="radio"]:checked').each(function(){
                var lp = $(this).data('price');
                price += (lp || 0);
            });

            this.price = Math.round(price);
            this.cont.children('.price').html(this.currency + this.price);

            tempPrice || this.room.trigger('priceChange');
        }
    },

    isValidType: function(value, type){
        switch(type){
            case 'string':
                return ($.trim(value).length >= 2);

            case 'string_heb':
                return ($.trim(value).length >= 2 && (new RegExp('^[\\s\'א-ת]+$')).test($.trim(value)));

            case 'string_eng':
                return !($.trim(value).length < 2 || /[^a-zA-Z'\s]/.test($.trim(value)));

            case 'numeric':
                return /^\d+$/.test($.trim(value));

            case 'email':
                return /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/.test($.trim(value));

            case 'date':
                return /^\d{2}\D\d{2}\D\d{4}$/.test($.trim(value));

            default:
                return true;
        }
    }
});


function OrderPop(options){
    var self = this, dr = $(options.pop).find('.rentDays');

    this.main   = options.main;
    this.person = options.person;
    this.cont   = $(options.pop);
    this.dates  = dr.length ? new DateRange(dr, this) : null;

    this.onDateChange = options.onDateChange || null;
    this.onSubmit     = options.onSubmit || null;

    this.cont.find('.submit, .closer').click(function(){
        self.onSubmit && self.onSubmit(self.popData());
        self.close();
    });

    options.onSelect && this.cont.find('.radiocont').on('click', 'input[type="radio"]', options.onSelect);

    this.cont.data('OrderPop', this);
}

$.extend(OrderPop.prototype, {
    open: function(){
        if (this.cont.length && (this.main || this.person.type)){
            this.cont.addClass("open");
            this.person.stopper.push(this.cont.attr('id'));
            $('body').addClass('noscrollpop');
        }
    },

    close: function(){
        var id = this.cont.attr('id'), i;

        this.cont.removeClass("open");
        while((i = this.person.stopper.indexOf(id)) >= 0)
            this.person.stopper.splice(i, 1);
        this.person.stopper.length || $('body').removeClass('noscrollpop');
    },

    /*run: function(){
        this.cont.find('.submit').trigger('click');
    },*/

    datesChange: function(from, till){
        var self = this, req = $.extend({from: from, till: till}, this.cont.data('req'));
        $.get('/ajax_order.php', req).then(function(res){
            if (!res || res.status === undefined || parseInt(res.status))
                alert(res ? (res.error || res._txt) : 'Unknown error. please reload page.');

            self.onDateChange && res.days && self.onDateChange.call(self, from, till, res.days);

            self.cont.find('input[type="radio"]').each(function(){
                var inp = $(this), data = inp.data(), tmp;

                if (data.price){
                    if (res.prices[this.value]){
                        data.price = res.prices[this.value];

                        tmp = inp.siblings('.boxprice').add(inp.parent().siblings('.prices'));
                        if (tmp.length)
                            tmp[0].innerHTML = tmp[0].innerHTML.substr(0, 1) + data.price;

                        inp.closest('.isline').show();
                    } else {
                        if (this.checked){
                            this.checked = false;
                            self.cont.find('input[type="radio"][value="0"]').click();
                        }
                        inp.closest('.isline').removeClass('active').hide();
                    }
                }
            });
        });
    },

    popData: function(){
        var selected = this.cont.find('.radiocont input[type="radio"]:checked')[0];
        return this.dates ? {from:this.dates.eFrom.value, till:this.dates.eTill.value, selected:selected} : {from:'', till:'', selected:selected};
    },

    cancel: function(){
        var none = this.cont.find('input.noneSelect');
        if (!none.prop('checked')){
            none.click();
            this.onSubmit && this.onSubmit(this.popData());
        }
    },

    hebDays: function(days){
        switch(days){
            case 1:
                return 'יום אחד';
            case 2:
                return 'יומיים';
            default:
                return '' + days + ' ימים';
        }
    }
});


function OrderBigRoom(elem, papa) {
    var self = this, cont = $(elem), names = [], head = '';

    this.html = {
        cont: cont,
        price: cont.find('.price span')
    };

    this.nprice = cont.data('initPrice');
    this.people = [];
    this.order  = papa;
    this.has_price = !papa.siteData.no_price;

    cont.find('.personLine').each(function(){
        var ind = this.id.substr(6).split('_'), person = $(this);
        self.people.push(new OrderPerson(this, self, ind[0], ind[1], papa._counter(), papa.splitToken));
    });
}
$.extend(OrderBigRoom.prototype, {
    price: function(){
        return parseInt(this.nprice);
    },

    changePrice: function(final){
        var total = 0;
        $.each(this.people, function(i, p){
            total += p.price;
        });
        this.nprice = Math.round(total);

        final || this.order.trigger('priceChange');

        return total;
    },

    getEditable: function(){
        return $.map(this.people, function(person){
            var d = person.details();
            return d.disabled ? null : d;
        });
    },

    getHead: function(){
        return this.people.reduce(function(head, person){
            var d;
            return head ? head : ((d = person.details()).isHead ? d : null);
        }, null);
    },

    recalc: function(){
        $.each(this.people, function(i, p){
            p.renewPrice(true);
        });
        return this.changePrice(true);
    },

    trigger: function(type, value){
        switch(type){
            case 'priceChange':
                this.changePrice();
                break;

            case 'ageChange':
                var room = this, newVal = $.extend({}, value);

                newVal.callback = function(data){
                    var pin = room.people.indexOf(value.person);

                    switch(data.act){
                        case 'html':
                            var elem = $(data.html)[0];

                            value.person.closeAll();
                            value.person.cont.replaceWith(elem);

                            room.people[pin] = new OrderPerson(elem, room, value.rin, value.pin, value.person.globIndex, room.order.splitToken);
                            room.people[pin].renewPrice();
                            break;

                        default:
                            value.callback && value.callback(data);
                            break;
                    }
                };

                this.order.checkAge(newVal);
                break;
        }
    },

    needCheck: function(){
        return !this.order.orderData.nocheck;
    }
});

function DateRange(cont, owner){
    var self = this;

    this.popup   = owner;
    this.eFrom   = null;
    this.eTill   = null;
    this.eNights = $(cont).find('.nights')[0];

    $(cont).find('input.datepicker').each(function(){
        if (/from/i.test(this.name)){
            self.eFrom = this;
            $(this).datepicker({
                dateFormat: 'dd.mm.yy',
                minDate: 0,
                onSelect: function(date){
                    self.rangeChange();
                }
            });
        }
        else if (/till/i.test(this.name)){
            self.eTill = this;
            $(this).datepicker({
                dateFormat: 'dd.mm.yy',
                beforeShow: function(){
                    return {minDate: self.eFrom.value || 0};
                },
                onSelect: function(date){
                    self.rangeChange();
                }
            });
        }
    });
}

$.extend(DateRange.prototype, {
    rangeChange: function(){
        if (this.eFrom.value && this.eTill.value){
            //var n = realDate(this.eFrom.value).diff(realDate(this.eTill.value));

            //this.eNights.innerHTML = (n == 1) ? 'לילה אחד' : '' + n + ' לילות';
            this.popup.datesChange(properDate(this.eFrom.value), properDate(this.eTill.value));
        }
    }
});
